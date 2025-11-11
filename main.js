const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { spawn, exec } = require('child_process');
const os = require('os');

// Server management
let serverProcess = null;
let inProcessServer = null; // Track in-process server instance
let mainWindow = null;
let serverSettings = {
    port: 7522,
    logLevel: 'info',
    logToFile: false,
    autoStart: false,
    openBrowserOnStart: false
};

// Settings file path
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// App info
const APP_INFO = {
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch
};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 500,
        height: 700,
        minWidth: 400,
        minHeight: 600,
        maxWidth: 600,
        resizable: true,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        titleBarStyle: 'default',
        show: false,
        center: true,
        backgroundColor: '#0f172a', // Set dark background to prevent white flash
        vibrancy: null // Disable vibrancy on macOS to prevent flashing
    });

    mainWindow.loadFile(path.join(__dirname, 'launcher', 'index.html'));

    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// App event handlers
app.whenReady().then(async () => {
    await loadSettings();
    createWindow();

    // Auto-start server only if enabled in settings
    setTimeout(() => {
        console.log('Checking auto-start setting in main.js...');
        console.log('Current serverSettings:', JSON.stringify(serverSettings, null, 2));
        
        if (serverSettings && serverSettings.autoStart === true) {
            console.log('Auto-start is enabled - starting server');
            const result = startServer();
            if (result && !result.success) {
                console.error('Failed to auto-start server:', result.error);
            }
        } else {
            console.log('Auto-start is disabled - skipping server start');
        }
    }, 1000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        stopServer();
        app.quit();
    }
});

app.on('before-quit', () => {
    stopServer();
});

// Settings management
async function loadSettings() {
    try {
        const data = await fs.readFile(settingsPath, 'utf8');
        serverSettings = { ...serverSettings, ...JSON.parse(data) };
    } catch (error) {
        // Use default settings if file doesn't exist or is invalid
        console.log('Using default settings');
    }
}

async function saveSettings(settings) {
    try {
        serverSettings = { ...serverSettings, ...settings };
        await fs.writeFile(settingsPath, JSON.stringify(serverSettings, null, 2));
        return { success: true };
    } catch (error) {
        console.error('Error saving settings:', error);
        return { success: false, error: error.message };
    }
}

// Server management functions
function startServer() {
    if (serverProcess) {
        return { success: false, error: 'Server is already running' };
    }

    try {
        // Handle both development and production paths
        let serverPath;
        let workingDir;
        
        if (app.isPackaged) {
            // In production, try multiple possible locations for server.js
            const possiblePaths = [
                path.join(process.resourcesPath, 'app.asar.unpacked', 'server.js'),
                path.join(process.resourcesPath, 'server.js'),
                path.join(app.getAppPath(), 'server.js'),
                path.join(__dirname, 'server.js')
            ];
            
            console.log('Checking possible server paths:');
            for (const testPath of possiblePaths) {
                console.log(`  ${testPath}: ${require('fs').existsSync(testPath)}`);
                if (require('fs').existsSync(testPath)) {
                    serverPath = testPath;
                    break;
                }
            }
            
            if (!serverPath) {
                throw new Error('Could not find server.js in packaged app');
            }
            
            workingDir = path.dirname(serverPath);
        } else {
            // In development
            serverPath = path.join(__dirname, 'server.js');
            workingDir = __dirname;
        }

        const env = {
            ...process.env,
            WEB_PORT: serverSettings.port.toString(),
            LOG_LEVEL: serverSettings.logLevel,
            LOG_TO_FILE: serverSettings.logToFile.toString()
        };

        // Find the actual Node.js executable (not Electron)
        let nodeExecutable;
        if (app.isPackaged) {
            // In packaged app, use the system Node.js
            nodeExecutable = 'node';
        } else {
            // In development, use system Node.js
            nodeExecutable = 'node';
        }

        // Use actual Node.js executable, not Electron
        serverProcess = spawn(nodeExecutable, [serverPath], {
            env,
            cwd: workingDir,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Handle server output
        serverProcess.stdout.on('data', (data) => {
            const message = data.toString();
            sendToRenderer('server-log', { message, level: 'info' });
        });

        serverProcess.stderr.on('data', (data) => {
            const message = data.toString();
            sendToRenderer('server-log', { message, level: 'error' });
        });

        serverProcess.on('close', (code) => {
            serverProcess = null;
            sendToRenderer('server-status', { running: false, code });
        });

        serverProcess.on('error', (error) => {
            console.error('Server process error:', error);
            serverProcess = null;
            sendToRenderer('server-log', { 
                message: `Server error: ${error.message}`, 
                level: 'error' 
            });
            sendToRenderer('server-status', { running: false, error: error.message });
        });

        // Send initial status
        sendToRenderer('server-status', { running: true });
        sendToRenderer('server-log', { 
            message: `Server starting on port ${serverSettings.port}`, 
            level: 'info' 
        });

        // Open browser if setting is enabled
        if (serverSettings.openBrowserOnStart) {
            setTimeout(() => {
                const url = `http://localhost:${serverSettings.port}`;
                shell.openExternal(url);
            }, 2000); // Wait 2 seconds for server to fully start
        }

        return { success: true };
    } catch (error) {
        console.error('Error starting server:', error);
        sendToRenderer('server-log', { 
            message: `Failed to start server: ${error.message}`, 
            level: 'error' 
        });
        return { success: false, error: error.message };
    }
}

// Alternative method to start server in-process for packaged apps
function startServerInProcess() {
    if (serverProcess || inProcessServer) {
        return { success: false, error: 'Server is already running' };
    }

    try {
        // Check if server.js is accessible and readable
        let serverPath;
        if (app.isPackaged) {
            const possiblePaths = [
                path.join(process.resourcesPath, 'app.asar.unpacked', 'server.js'),
                path.join(process.resourcesPath, 'server.js'),
                path.join(app.getAppPath(), 'server.js'),
                path.join(__dirname, 'server.js')
            ];
            
            for (const testPath of possiblePaths) {
                if (require('fs').existsSync(testPath)) {
                    serverPath = testPath;
                    break;
                }
            }
        } else {
            serverPath = path.join(__dirname, 'server.js');
        }
        
        if (!serverPath || !require('fs').existsSync(serverPath)) {
            throw new Error('Could not find server.js file');
        }
        
        console.log('Starting server in-process using path:', serverPath);
        
        // Set environment variables for the server
        process.env.WEB_PORT = serverSettings.port.toString();
        process.env.LOG_LEVEL = serverSettings.logLevel;
        process.env.LOG_TO_FILE = serverSettings.logToFile.toString();
        
        // Delete from require cache to ensure fresh load
        const resolvedPath = require.resolve(serverPath);
        if (require.cache[resolvedPath]) {
            delete require.cache[resolvedPath];
        }
        
        console.log('About to require server module...');
        
        // Check for required dependencies before starting
        const requiredDependencies = [
            'express', 
            'socket.io', 
            'winston', 
            'cors',
            'body-parser'
        ];
        
        const missingDependencies = [];
        for (const dep of requiredDependencies) {
            try {
                require.resolve(dep);
                console.log(`${dep} module is available`);
            } catch (moduleError) {
                missingDependencies.push(dep);
                console.error(`Missing dependency: ${dep}`);
            }
        }
        
        if (missingDependencies.length > 0) {
            throw new Error(`Missing dependencies: ${missingDependencies.join(', ')}`);
        }
        
        // Try to load the server module
        let serverModule;
        try {
            serverModule = require(serverPath);
        } catch (requireError) {
            // Enhanced error reporting for module require errors
            if (requireError.code === 'MODULE_NOT_FOUND') {
                const missingModule = (requireError.message.match(/Cannot find module '([^']+)'/) || [])[1];
                throw new Error(`Missing dependency: ${missingModule || 'unknown module'}`);
            }
            throw requireError;
        }
        
        console.log('Server module loaded, starting server...');
        
        // Start the server using the exported function
        if (typeof serverModule.startServer === 'function') {
            // Wrap in a timeout to prevent hanging
            const startupTimeout = setTimeout(() => {
                throw new Error('Server startup timed out after 10 seconds');
            }, 10000);
            
            try {
                serverModule.startServer();
                inProcessServer = serverModule.server;
                clearTimeout(startupTimeout);
                console.log('Server started successfully in-process');
            } catch (startupError) {
                clearTimeout(startupTimeout);
                throw startupError;
            }
        } else {
            throw new Error('Server module does not export startServer function');
        }
        
        // Mark as running
        serverProcess = { inProcess: true };
        
        sendToRenderer('server-status', { running: true });
        sendToRenderer('server-log', { 
            message: `Server started in-process on port ${serverSettings.port}`, 
            level: 'info' 
        });

        // Open browser if setting is enabled
        if (serverSettings.openBrowserOnStart) {
            setTimeout(() => {
                const url = `http://localhost:${serverSettings.port}`;
                shell.openExternal(url);
            }, 2000); // Wait 2 seconds for server to fully start
        }

        return { success: true };
    } catch (error) {
        console.error('Error starting server in-process:', error);
        sendToRenderer('server-log', { 
            message: `Failed to start server in-process: ${error.message}`, 
            level: 'error' 
        });
        return { success: false, error: error.message };
    }
}

function stopServer() {
    if (!serverProcess && !inProcessServer) {
        return { success: false, error: 'Server is not running' };
    }

    try {
        if (serverProcess && serverProcess.inProcess && inProcessServer) {
            // For in-process server, close the HTTP server
            inProcessServer.close(() => {
                sendToRenderer('server-log', { 
                    message: 'In-process server stopped', 
                    level: 'info' 
                });
            });
            serverProcess = null;
            inProcessServer = null;
            sendToRenderer('server-status', { running: false });
            return { success: true };
        } else if (serverProcess && !serverProcess.inProcess) {
            serverProcess.kill('SIGTERM');
            serverProcess = null;
            sendToRenderer('server-status', { running: false });
            return { success: true };
        } else {
            serverProcess = null;
            inProcessServer = null;
            sendToRenderer('server-status', { running: false });
            return { success: true };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function getServerStatus() {
    return {
        running: serverProcess !== null,
        port: serverSettings.port,
        url: `http://localhost:${serverSettings.port}`,
        inProcess: serverProcess && serverProcess.inProcess
    };
}

// Performance stats
function getPerformanceStats() {
    const memUsage = process.memoryUsage();
    return {
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024),
            total: Math.round(memUsage.heapTotal / 1024 / 1024)
        },
        uptime: process.uptime(),
        connections: serverProcess ? 'Active' : 'None'
    };
}

// Utility function to send messages to renderer
function sendToRenderer(channel, data) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(channel, data);
    }
}

// IPC handlers
ipcMain.handle('get-settings', () => {
    return serverSettings;
});

ipcMain.handle('save-settings', async (event, settings) => {
    return await saveSettings(settings);
});

ipcMain.handle('reset-settings', async () => {
    const defaultSettings = {
        port: 7522,
        logLevel: 'info',
        logToFile: false,
        autoStart: false,
        openBrowserOnStart: false
    };
    return await saveSettings(defaultSettings);
});

ipcMain.handle('start-server', () => {
    // Try in-process method first (better for packaged apps)
    if (app.isPackaged) {
        return startServerInProcess();
    } else {
        return startServer();
    }
});

ipcMain.handle('stop-server', () => {
    return stopServer();
});

ipcMain.handle('get-server-status', () => {
    return getServerStatus();
});

ipcMain.handle('open-web-interface', () => {
    const url = `http://localhost:${serverSettings.port}`;
    shell.openExternal(url);
    return { success: true, url };
});

ipcMain.handle('get-app-info', () => {
    return APP_INFO;
});

ipcMain.handle('get-performance-stats', () => {
    return getPerformanceStats();
});

ipcMain.handle('show-message-box', async (event, options) => {
    const result = await dialog.showMessageBox(mainWindow, options);
    return result;
});

// Check if port is available
function checkPortAvailable(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        
        server.listen(port, () => {
            server.once('close', () => {
                resolve(true);
            });
            server.close();
        });
        
        server.on('error', () => {
            resolve(false);
        });
    });
}

ipcMain.handle('check-port-available', async (event, port) => {
    return await checkPortAvailable(port);
});

ipcMain.handle('check-dependencies', async () => {
    const criticalDependencies = [
        'express', 
        'socket.io', 
        'winston', 
        'cors',
        'body-parser'
    ];
    
    const missingDependencies = [];
    const availableDependencies = [];
    
    for (const dep of criticalDependencies) {
        try {
            require.resolve(dep);
            availableDependencies.push(dep);
        } catch (error) {
            missingDependencies.push(dep);
        }
    }
    
    return {
        missing: missingDependencies,
        available: availableDependencies,
        isReady: missingDependencies.length === 0
    };
});

ipcMain.handle('get-local-ip', () => {
    const interfaces = os.networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    
    return '127.0.0.1'; // Fallback to localhost
});