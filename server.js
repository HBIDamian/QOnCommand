/**
 * QOnCommand - Node.js version
 * Professional web-based remote control for QLab
 */

// Helper function to safely require modules
function safeRequire(moduleName) {
    try {
        return require(moduleName);
    } catch (error) {
        console.error(`ERROR: Failed to load module "${moduleName}": ${error.message}`);
        throw new Error(`Missing dependency: ${moduleName}`);
    }
}

// Core dependencies
const express = safeRequire('express');
// Note: body-parser is included in Express 4.16+ via express.json() and express.urlencoded()
const http = require('http');
const socketIo = safeRequire('socket.io');
const osc = safeRequire('osc');
const bonjour = safeRequire('bonjour-service');
const winston = safeRequire('winston');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cors = safeRequire('cors');

// Configuration
const WEB_PORT = parseInt(process.env.WEB_PORT) || 7522;
const BUNDLE_ID = 'com.figure53.QLab.4';

// Logging configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // Changed from debug to info for better performance
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true' || false;

// Configure Winston logger
const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
);

const transports = [new winston.transports.Console()];
if (LOG_TO_FILE) {
    transports.push(new winston.transports.File({ 
        filename: path.join(__dirname, 'qoncommand.log') 
    }));
}

const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: logFormat,
    transports: transports
});

// Express app setup
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Handle new client connections and send server info
io.on('connection', (socket) => {
    logger.info(`Socket client connected: ${socket.id}`);
    socket.emit('serverInfo', {
        nodeVersion: process.version,
        port: WEB_PORT,
        ip: getLocalIpAddress()
    });
    
    // Initialize client connection state
    clientConnections.set(socket.id, {
        instance: null,
        client: null,
        selectedCue: { number: "", name: "" },
        nextCue: { number: "", name: "" }
    });
    
    // Clean up when client disconnects
    socket.on('disconnect', () => {
        logger.info(`Socket client disconnected: ${socket.id}`);
        const clientData = clientConnections.get(socket.id);
        if (clientData && clientData.workspaceId) {
            // Don't immediately clean up workspace connection - keep it alive for reconnects
            setTimeout(() => {
                // Only remove if client hasn't reconnected in 30 seconds
                const stillExists = clientConnections.has(socket.id);
                if (!stillExists) {
                    logger.info(`Cleaning up abandoned client ${socket.id} from workspace ${clientData.workspaceId}`);
                    removeClientFromWorkspace(socket.id, clientData.workspaceId);
                }
            }, 30000); // 30 second grace period
        }
        // Don't delete client connection immediately - allow for reconnection
        setTimeout(() => {
            const stillExists = clientConnections.has(socket.id);
            if (stillExists) {
                logger.info(`Removing stale client connection: ${socket.id}`);
                clientConnections.delete(socket.id);
            }
        }, 30000);
    });
});

// Middleware
app.use(cors());
app.use(express.json()); // Built-in body-parser for JSON
app.use(express.urlencoded({ extended: true })); // Built-in body-parser for form data
app.use(express.static(path.join(__dirname, 'public')));

// Global state
let discoveredInstances = [];
let eventHistory = [];
const maxEventHistory = 50;

// Workspace connection pooling - share connections between clients
const workspacePool = new Map(); // workspaceId -> { client, refCount, clients: Set() }

// Per-client workspace connections
const clientConnections = new Map(); // socketId -> { workspaceId, selectedCue, nextCue }

// Global cue cache to persist across client reconnections
const globalCueCache = new Map(); // workspaceId -> { cues, lastUpdate }

// Performance tracking
let commandsSent = 0;
let errorCount = 0;
let totalLatencyMs = 0.0;

// Global OSC port singleton - shared across all clients
let globalOSCPort = null;
let globalOSCCallbacks = new Map();

// Global OSC message handler function
function handleGlobalOSCMessage(oscMessage) {
    try {
        const address = oscMessage.address;
        const args = oscMessage.args;
        
        logger.debug(`OSC message received: ${address} with ${args.length} args`);
        
        // QLab sends responses with address like /reply/version, /reply/workspaces, etc.
        // The first arg is a JSON string: {"status":"ok", "address":"/workspaces", "data": [...]}
        
        let parsedData = null;
        
        // Handle both reply messages and update messages as per C# reference
        if (address.startsWith('/reply')) {
            if (args.length > 0 && args[0].value) {
                try {
                    // Try to parse the first argument as JSON
                    const jsonData = JSON.parse(args[0].value);
                    logger.debug(`Parsed JSON response: status=${jsonData.status}, has data=${jsonData.data !== undefined}`);
                    
                    if (jsonData.status === 'ok') {
                        parsedData = jsonData.data;
                    } else {
                        logger.warn(`QLab returned error status: ${jsonData.status}`);
                    }
                } catch (parseError) {
                    logger.error(`Failed to parse JSON response: ${parseError.message}`);
                    parsedData = args.map(arg => arg.value);
                }
            } else {
                parsedData = args.map(arg => arg.value);
            }
            
            // For TCP OSC, we can safely use FIFO since TCP guarantees order
            // But let's also handle the case where no callbacks are waiting
            const globalCallbacks = Array.from(globalOSCCallbacks.entries());
            if (globalCallbacks.length > 0) {
                const [callbackId, callback] = globalCallbacks[0];
                globalOSCCallbacks.delete(callbackId);
                
                // Reduced logging for performance
                if (parsedData !== null) {
                    callback(null, parsedData);
                } else {
                    callback(new Error(`QLab returned error`), null);
                }
            } else {
                // Silently handle when no callbacks are waiting
            }
        } else if (address.includes('update')) {
            // Handle live update messages as per QParser.cs pattern
            logger.debug(`Received QLab update message: ${address}`);
            
            if (address.includes('playbackPosition')) {
                logger.debug(`Playback position update received - updating cue info`);
                // Trigger debounced cue info update for all clients when playback position changes
                updateAllClientsCueInfo();
            } else if (address.includes('cueList')) {
                logger.debug(`Cue list update received - updating cue info`);
                // Refresh cue list data (debounced)
                updateAllClientsCueInfo();
            } else if (address.includes('cue_id')) {
                logger.debug(`Specific cue update received - updating cue info`);
                // Update individual cue information (debounced)
                updateAllClientsCueInfo();
            } else if (address.endsWith('update')) {
                logger.debug(`General workspace update received - updating cue info`);
                // Trigger general workspace refresh (debounced)
                updateAllClientsCueInfo();
            }
        } else if (address.includes('thump')) {
            // Heartbeat message - just log at debug level
            logger.debug('QLab heartbeat received');
        } else {
            logger.debug(`Unhandled OSC message: ${address}`);
        }
    } catch (error) {
        logger.error(`Error handling global OSC message: ${error.message}`);
    }
}

/**
 * QLab OSC Client - Node.js version using OSC protocol with Zeroconf discovery
 */
class QLabOSCClient {
    constructor(host = null, port = null, replyPort = 53001) {
        this.host = host;
        this.port = port;
        this.replyPort = replyPort;
        this.oscPort = null; // Will use global port
        this.callbackIdCounter = 0;
        this.currentWorkspaceId = null;
        this.connected = false;
        this.discoveredInstances = [];
        this.bonjour = new bonjour.default();
        
        // Performance caching with reasonable timeout to prevent OSC flooding
        this.selectedCueCache = null;
        this.activeCueCache = null;
        this.nextCueCache = null;
        this.cueListCache = null;
        this.cacheTimeout = 1000; // 1 second cache to reduce OSC requests and prevent timeouts
        this.lastSelectedUpdate = 0;
        this.lastActiveUpdate = 0;
        this.lastNextUpdate = 0;
        this.lastCueListUpdate = 0;
        
        // Start by discovering QLab instances if no host specified
        if (!this.host || !this.port) {
            this.discoverQLab();
        } else {
            this.initializeOSC();
        }
    }

    initializeOSC() {
        try {
            // Use global OSC port (singleton pattern to avoid port conflicts)
            // Using TCP as per QLab OSC specification and C# reference implementation
            if (!globalOSCPort) {
                globalOSCPort = new osc.TCPSocketPort({
                    address: this.host || "127.0.0.1",
                    port: this.port || 53000,
                    metadata: true
                });
                
                // Handle incoming OSC messages
                globalOSCPort.on('message', handleGlobalOSCMessage);
                
                // Handle errors
                globalOSCPort.on('error', (err) => {
                    logger.error(`Global OSC TCP Port error: ${err.message}`);
                });
                
                // Handle connection close
                globalOSCPort.on('close', () => {
                    logger.warn('Global OSC TCP Port closed - will reconnect on next use');
                    globalOSCPort = null; // Allow reconnection
                });
                
                // Handle ready event
                globalOSCPort.on('ready', () => {
                    logger.info(`Global OSC TCP Port connected to QLab on ${this.host || "127.0.0.1"}:${this.port || 53000}`);
                });
                
                // Open the connection
                globalOSCPort.open();
            }
            
            this.oscPort = globalOSCPort;

            logger.info(`OSC Client initialized - will send to ${this.host}:${this.port}, listening on port ${this.replyPort}`);
            
            // Auto-discover workspace after a short delay to let OSC stabilize
            setTimeout(() => {
                this.autoSelectWorkspace().catch(err => {
                    logger.warn(`Auto workspace selection failed: ${err.message}`);
                });
            }, 1000);
            
        } catch (error) {
            logger.error(`Failed to initialize OSC: ${error.message}`);
            throw error;
        }
    }

    async discoverQLab() {
        try {
            logger.info('Starting QLab discovery via Bonjour/Zeroconf...');
            
            // Browse for QLab services
            const browser = this.bonjour.find({ type: 'qlab', protocol: 'tcp' });
            
            browser.on('up', (service) => {
                logger.info(`Found QLab instance: ${service.name} at ${service.referer.address}:${service.port}`);
                
                this.discoveredInstances.push({
                    name: service.name,
                    host: service.referer.address,
                    port: service.port,
                    type: service.type
                });

                // Use the first discovered instance
                if (!this.host && !this.port) {
                    this.host = service.referer.address;
                    this.port = service.port;
                    logger.info(`Connecting to QLab at ${this.host}:${this.port}`);
                    this.initializeOSC();
                }
            });

            browser.on('down', (service) => {
                logger.info(`QLab instance went down: ${service.name}`);
                this.discoveredInstances = this.discoveredInstances.filter(
                    instance => instance.name !== service.name
                );
            });

            // Fallback to localhost if no services found after 3 seconds
            setTimeout(() => {
                if (!this.host || !this.port) {
                    logger.warn('No QLab instances found via Bonjour, falling back to localhost:53000');
                    this.host = '127.0.0.1';
                    this.port = 53000;
                    this.initializeOSC();
                }
            }, 3000);

        } catch (error) {
            logger.error(`Error during QLab discovery: ${error.message}`);
            // Fallback to localhost
            this.host = '127.0.0.1';
            this.port = 53000;
            this.initializeOSC();
        }
    }



    async sendOSCMessage(address, args = [], expectReply = false) {
        return new Promise((resolve, reject) => {
            try {
                // Build OSC message with the osc library format
                const oscMessage = {
                    address: address,
                    args: args.map(arg => ({
                        type: typeof arg === 'number' ? (Number.isInteger(arg) ? 'i' : 'f') : 's',
                        value: arg
                    }))
                };
                
                if (expectReply) {
                    const callbackId = ++this.callbackIdCounter;
                    const timeout = setTimeout(() => {
                        // Check and clean up from global callbacks
                        if (globalOSCCallbacks.has(callbackId)) {
                            globalOSCCallbacks.delete(callbackId);
                            logger.warn(`OSC message timeout for ${address} after 10 seconds`);
                            errorCount++;
                            reject(new Error('OSC message timeout'));
                        }
                    }, 10000); // 10 second timeout for TCP (increased for stability)

                    const callbackFn = (error, result) => {
                        clearTimeout(timeout);
                        if (error) {
                            reject(error);
                        } else {
                            resolve(result);
                        }
                    };
                    
                    // Store in global callback map
                    globalOSCCallbacks.set(callbackId, callbackFn);
                }

                // Send the OSC message via TCP connection
                this.oscPort.send(oscMessage);
                // Reduced logging for performance - only log important messages
                if (address.includes('connect') || address.includes('workspace') && !address.includes('/cue/selected/')) {
                    logger.debug(`OSC: ${address}`);
                }
                
                if (!expectReply) {
                    resolve(true);
                }
            } catch (error) {
                logger.error(`OSC sendMessage error: ${error.message}`);
                reject(error);
            }
        });
    }

    async isRunning() {
        try {
            // Wait for initialization if still discovering
            if (!this.oscPort) {
                await new Promise(resolve => {
                    const checkInit = () => {
                        if (this.oscPort) {
                            resolve();
                        } else {
                            setTimeout(checkInit, 100);
                        }
                    };
                    checkInit();
                });
            }

            logger.info(`Testing OSC connection to ${this.host}:${this.port}`);
            
            // Try to get QLab version - this is a simple test that QLab will respond to
            try {
                await this.sendOSCMessage('/version', [], false);
                logger.info('Successfully sent version request to QLab');
                this.connected = true;
                return true;
            } catch (sendError) {
                logger.error(`Failed to connect to QLab: ${sendError.message}`);
                this.connected = false;
                return false;
            }
        } catch (error) {
            logger.error(`Error checking if QLab is running: ${error.message}`);
            this.connected = false;
            return false;
        }
    }

    async getWorkspaces() {
        try {
            // Wait for OSC port to be ready
            if (!this.oscPort) {
                await new Promise(resolve => {
                    const checkInit = () => {
                        if (this.oscPort) {
                            resolve();
                        } else {
                            setTimeout(checkInit, 100);
                        }
                    };
                    checkInit();
                });
            }

            logger.info('Attempting to get workspaces via OSC...');
            
            try {
                // Request workspaces list from QLab
                const result = await this.sendOSCMessage('/workspaces', [], true);
                logger.info(`Received workspaces response: ${JSON.stringify(result)}`);
                
                // Result is the parsed data array from JSON
                if (Array.isArray(result) && result.length > 0) {
                    // Each workspace is an object with displayName, uniqueID, etc.
                    return result.map(ws => ({
                        name: ws.displayName || `QLab Workspace`,
                        id: ws.uniqueID || "",
                        hasPasscode: ws.hasPasscode || false
                    }));
                }
            } catch (error) {
                logger.warn(`Could not get workspaces via OSC: ${error.message}`);
            }
            
            // Fallback: return a default workspace
            const workspaces = [{
                name: "QLab (Default)",
                id: "", 
                hasPasscode: false
            }];
            
            logger.info(`Using fallback workspace list`);
            return workspaces;
        } catch (error) {
            logger.error(`Error getting workspaces: ${error.message}`);
            return [{
                name: "QLab (Default)",
                id: "",
                hasPasscode: false
            }];
        }
    }

    async setActiveWorkspace(workspaceId) {
        try {
            // Store the workspace ID - if empty, commands go to /go, /stop etc without workspace prefix
            this.currentWorkspaceId = workspaceId;
            
            if (workspaceId) {
                // Connect to a specific workspace as per C# reference implementation
                await this.sendOSCMessage(`/workspace/${workspaceId}/connect`, [], true);
                logger.info(`Connected to workspace: ${workspaceId}`);
                
                // Enable updates as per QUpdater.cs pattern
                await this.sendOSCMessage('/updates', [1], false);
                logger.info(`Enabled live updates for workspace: ${workspaceId}`);
                
                // Request cue lists as per QUpdater connection flow
                await this.sendOSCMessage(`/workspace/${workspaceId}/cueLists`, [], true);
                logger.info(`Requested cue lists for workspace: ${workspaceId}`);
                
            } else {
                // Using default/first workspace - no explicit connect needed
                logger.info(`Using default workspace (empty ID)`);
            }
            return true;
        } catch (error) {
            logger.error(`Error connecting to workspace ${workspaceId}: ${error.message}`);
            return false;
        }
    }

    async autoSelectWorkspace() {
        try {
            logger.info('Auto-selecting workspace...');
            const workspaces = await this.getWorkspaces();
            
            if (workspaces && workspaces.length > 0) {
                // Use the first available workspace
                const firstWorkspace = workspaces[0];
                logger.info(`Auto-selecting first available workspace: ${firstWorkspace.displayName || firstWorkspace.name} (${firstWorkspace.uniqueID || firstWorkspace.id})`);
                const workspaceId = firstWorkspace.uniqueID || firstWorkspace.id;
                await this.setActiveWorkspace(workspaceId);
                return workspaceId;
            } else {
                logger.warn('No workspaces found for auto-selection');
            }
        } catch (error) {
            logger.warn(`Could not auto-select workspace: ${error.message}`);
        }
        
        return null;
    }

    async getSelectedCue() {
        try {
            const now = Date.now();
            
            // Use cache if fresh
            if (this.selectedCueCache && (now - this.lastSelectedUpdate) < this.cacheTimeout) {
                return this.selectedCueCache;
            }
            
            // Use the correct QLab OSC format with valuesForKeys (matches C# app)
            const valuesForKeys = '["number","uniqueID","flagged","listName","type","colorName","name","armed","displayName","isBroken","isLoaded","isPaused","isRunning","preWait","duration","postWait","translationX","translationY","opacity","scaleX","scaleY","notes","levels"]';
            
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/cue/selected/valuesForKeys` 
                : '/cue/selected/valuesForKeys';
            
            const result = await this.sendOSCMessage(address, [valuesForKeys], true);
            
            let cueData;
            
            // Handle both cases: QLab can return either a direct object or an array
            let selectedCue = null;
            if (result) {
                if (Array.isArray(result) && result.length > 0) {
                    // Array format: use first item
                    selectedCue = result[0];
                } else if (result.uniqueID || result.number || result.name || result.listName) {
                    // Direct object format: use result directly
                    selectedCue = result;
                }
            }
            
            if (selectedCue) {
                cueData = {
                    id: selectedCue.uniqueID || '',
                    number: selectedCue.number || '--',
                    name: selectedCue.listName || selectedCue.displayName || selectedCue.name || 'No selection',
                    type: selectedCue.type || 'unknown'
                };
                logger.debug(`✅ Selected cue info: ${selectedCue.number} - ${selectedCue.listName || selectedCue.displayName}`);
            } else {
                cueData = {
                    number: '--',
                    name: 'No selection',
                    type: 'unknown'
                };
                logger.debug(`❌ No selected cue found in response: ${JSON.stringify(result).substring(0, 100)}`);
            }
            
            // Update cache
            this.selectedCueCache = cueData;
            this.lastSelectedUpdate = now;
            
            return cueData;
        } catch (error) {
            logger.debug(`Error getting selected cue: ${error.message}`);
            
            // Return cached value if available and not too old (10 seconds max)
            if (this.selectedCueCache && (Date.now() - this.lastSelectedUpdate) < 10000) {
                logger.debug('OSC error, using cached selected cue');
                return this.selectedCueCache;
            }
            
            // Fallback to a neutral message instead of "Connection error"
            const errorCue = {
                number: '--',
                name: 'No selection',
                type: 'unknown'
            };
            return errorCue;
        }
    }

    async getNextCue() {
        const now = Date.now();
        
        try {
            // Use cache if fresh
            if (this.nextCueCache && (now - this.lastNextUpdate) < this.cacheTimeout) {
                return this.nextCueCache;
            }

            // Get the current selected cue first
            const selectedCue = await this.getSelectedCue();
            if (!selectedCue || !selectedCue.id) {
                const noCue = {
                    number: '--',
                    name: 'No selection',
                    type: 'unknown'
                };
                this.nextCueCache = noCue;
                this.lastNextUpdate = now;
                return noCue;
            }

            // Get the main cue list
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/cueLists` 
                : '/cueLists';
            
            const cueLists = await this.sendOSCMessage(address, [], true);
            
            if (cueLists && Array.isArray(cueLists) && cueLists.length > 0) {
                const mainCueList = cueLists[0]; // Main cue list
                if (mainCueList.cues && Array.isArray(mainCueList.cues)) {
                    // Find the currently selected cue in the list
                    const currentIndex = mainCueList.cues.findIndex(cue => cue.uniqueID === selectedCue.id);
                    
                    // If found and there's a next cue, return it
                    if (currentIndex !== -1 && currentIndex < mainCueList.cues.length - 1) {
                        const nextCue = mainCueList.cues[currentIndex + 1];
                        const result = {
                            id: nextCue.uniqueID || '',
                            number: nextCue.number || '--',
                            name: nextCue.listName || nextCue.name || 'Next Cue',
                            type: nextCue.type || 'unknown'
                        };
                        
                        this.nextCueCache = result;
                        this.lastNextUpdate = now;
                        return result;
                    }
                }
            }
            
            const endCue = {
                number: '--',
                name: 'End of list',
                type: 'unknown'
            };
            this.nextCueCache = endCue;
            this.lastNextUpdate = now;
            return endCue;
            
        } catch (error) {
            logger.debug(`Error getting next cue: ${error.message}`);
            
            // Return cached value if available and not too old (10 seconds max)
            if (this.nextCueCache && (now - this.lastNextUpdate) < 10000) {
                logger.debug('OSC error, using cached next cue');
                return this.nextCueCache;
            }
            
            // Fallback to a neutral message
            const errorCue = { 
                number: "--", 
                name: "No next cue", 
                type: "unknown" 
            };
            return errorCue;
        }
    }

    async getActiveCue() {
        try {
            const now = Date.now();
            
            // Use cache if fresh
            if (this.activeCueCache && (now - this.lastActiveUpdate) < this.cacheTimeout) {
                return this.activeCueCache;
            }
            
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/runningCues` 
                : '/runningCues';
            
            const result = await this.sendOSCMessage(address, [], true);
            
            let cueData;
            if (result && Array.isArray(result) && result.length > 0) {
                const activeCue = result[0];
                cueData = {
                    id: activeCue.uniqueID || '',
                    number: activeCue.number || '--',
                    name: activeCue.listName || activeCue.name || 'Running Cue',
                    type: activeCue.type || 'unknown'
                };
            } else {
                cueData = {
                    number: "--",
                    name: "No active cue",
                    type: "unknown"
                };
            }
            
            // Update cache
            this.activeCueCache = cueData;
            this.lastActiveUpdate = now;
            
            return cueData;
        } catch (error) {
            return {
                number: "--",
                name: "Not available",
                type: "unknown"
            };
        }
    }

    async go() {
        try {
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/go` 
                : '/go';
            await this.sendOSCMessage(address, [], false);
            logger.info('Sent GO command');
            return true;
        } catch (error) {
            logger.error(`Error sending go command: ${error.message}`);
            return false;
        }
    }

    async stop() {
        try {
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/stop` 
                : '/stop';
            await this.sendOSCMessage(address, [], false);
            logger.info('Sent STOP command');
            return true;
        } catch (error) {
            logger.error(`Error sending stop command: ${error.message}`);
            return false;
        }
    }

    async panic() {
        try {
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/panic` 
                : '/panic';
            await this.sendOSCMessage(address, [], false);
            logger.info('Sent PANIC command');
            return true;
        } catch (error) {
            logger.error(`Error sending panic command: ${error.message}`);
            return false;
        }
    }

    async reset() {
        try {
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/reset` 
                : '/reset';
            await this.sendOSCMessage(address, [], false);
            logger.info('Sent RESET command');
            return true;
        } catch (error) {
            logger.error(`Error sending reset command: ${error.message}`);
            return false;
        }
    }

    async next() {
        try {
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/select/next` 
                : '/select/next';
            await this.sendOSCMessage(address, [], false);
            logger.info('Sent NEXT command');
            return true;
        } catch (error) {
            logger.error(`Error sending next command: ${error.message}`);
            return false;
        }
    }

    async previous() {
        try {
            const address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/select/previous` 
                : '/select/previous';
            await this.sendOSCMessage(address, [], false);
            logger.info('Sent PREVIOUS command');
            return true;
        } catch (error) {
            logger.error(`Error sending previous command: ${error.message}`);
            return false;
        }
    }

    // Duplicate panic method - removed

    async getAllCues() {
        try {
            // First try to get all cueLists to see what's available
            let address = this.currentWorkspaceId 
                ? `/workspace/${this.currentWorkspaceId}/cueLists` 
                : '/cueLists';
            
            let result = await this.sendOSCMessage(address, [], true);
            logger.info(`Cue lists response for ${address}: ${JSON.stringify(result)}`);
            
            const cues = [];
            
            // If cueLists worked and returned cue lists
            if (result && Array.isArray(result) && result.length > 0) {
                // Check if this is the direct cue list array (QLab 4.x format)
                // First item might be a cue or might be the list itself
                if (result[0] && result[0].type === "Cue List") {
                    // This is a cue list container - process all items as cues
                    this.processCueList(result, cues, 0);
                } else if (result[0] && result[0].cues && Array.isArray(result[0].cues)) {
                    // Each cue list has a 'cues' array (older format)
                    result.forEach(cueList => {
                        this.processCueList(cueList.cues, cues, 0);
                    });
                } else {
                    // Direct cue array
                    this.processCueList(result, cues, 0);
                }
            } else {
                // Try alternative approach - get first cue list by ID
                address = this.currentWorkspaceId 
                    ? `/workspace/${this.currentWorkspaceId}/cue_id/1/children` 
                    : '/cue_id/1/children';
                
                result = await this.sendOSCMessage(address, [], true);
                logger.info(`Alternative cue approach for ${address}: ${JSON.stringify(result)}`);
                
                if (result && Array.isArray(result)) {
                    this.processCueList(result, cues, 0);
                }
            }
            
            if (cues.length === 0) {
                // Return a placeholder if no cues found
                return [{
                    number: "--",
                    name: "No cues available",
                    type: "info",
                    id: "none",
                    originalName: "No cues available",
                    depth: 0
                }];
            }
            
            logger.info(`Retrieved ${cues.length} cues from QLab`);
            return cues;
        } catch (error) {
            logger.error(`Error getting all cues: ${error.message}`);
            return [{
                number: "--",
                name: "Error loading cues",
                type: "error",
                id: "error",
                originalName: "Error loading cues",
                depth: 0
            }];
        }
    }

    processCueList(cueList, cues, depth) {
        for (let i = 0; i < cueList.length; i++) {
            const cue = cueList[i];
            
            // Add indentation based on depth level
            const prefix = "--> ".repeat(depth);
            const displayName = `${prefix}${cue.listName || cue.displayName || 'Unnamed'}`;
            
            cues.push({
                id: cue.uniqueID,
                number: cue.number || "--",
                name: displayName,
                originalName: cue.listName || cue.displayName || "Unnamed",
                originalIndex: i,
                depth: depth
            });

            // Process nested cues (groups)
            if (cue.cues && cue.cues.length > 0) {
                this.processCueList(cue.cues, cues, depth + 1);
            }
        }
    }

    async getCueInfo() {
        try {
            const selected = await this.getSelectedCue();
            const active = await this.getActiveCue();
            
            // Return combined info in AppleScript-compatible format
            return [
                selected.id || "",
                selected.number || "",
                selected.name || "",
                selected.type || "",
                "", "", "", "" // Next cue info - would need additional logic
            ];
        } catch (error) {
            logger.error(`Error getting cue info: ${error.message}`);
            return ["error", error.message];
        }
    }

    // Cache invalidation for immediate response
    invalidateCache() {
        this.selectedCueCache = null;
        this.activeCueCache = null;
        this.nextCueCache = null;
        this.lastSelectedUpdate = 0;
        this.lastActiveUpdate = 0;
        this.lastNextUpdate = 0;
    }

    cleanup() {
        try {
            // Don't close the global OSC port - other clients might be using it
            // Just clean up this client's resources
            if (this.bonjour) {
                this.bonjour.destroy();
            }
        } catch (error) {
            logger.error(`Error during cleanup: ${error.message}`);
        }
    }
}

/**
 * QLab Client Wrapper with caching and optimization
 */
class QLabClientWrapper {
    constructor(workspaceId = null) {
        this.client = new QLabOSCClient();
        this.currentSelectedCue = { number: "N/A", name: "Unnamed" };
        this.nextCue = { number: "N/A", name: "Unnamed" };
        this.workspaceId = workspaceId || "default";
        this.connected = false;
        this.connectionError = null;
        
        // Enhanced caching for performance and OSC stability
        this.cacheTimeout = 3000; // Longer cache timeout to prevent OSC timeouts
        this.lastCueUpdate = 0;
        this.cachedCues = [];
        this.lastCuesUpdate = 0;
        
        // Cache for individual cue info
        this.selectedCueCache = null;
        this.activeCueCache = null;
        this.nextCueCache = null;
        this.cueInfoCacheTimeout = 300; // Very fast cache for cue info
        this.lastSelectedCueUpdate = 0;
        this.lastActiveCueUpdate = 0;
        
        // Debouncing for cue selections
        this.lastSelectedCueId = null;
        this.lastSelectionTime = 0;
        this.lastNextCueUpdate = 0;
        
        this.initialize();
    }

    async initialize() {
        try {
            // Check if QLab is running
            if (await this.client.isRunning()) {
                this.connected = true;
                this.connectionError = null;
                
                // Skip workspace setting if using default ID
                if (this.workspaceId && this.workspaceId !== "applescript" && this.workspaceId !== "default") {
                    if (await this.client.setActiveWorkspace(this.workspaceId)) {
                        logger.info(`Set active workspace to ID: ${this.workspaceId}`);
                    } else {
                        logger.warn(`Could not set workspace ID: ${this.workspaceId}`);
                    }
                }
                
                logger.info("Successfully connected to QLab via OSC");
                await this.updateCueInfo();
            } else {
                this.connectionError = "QLab is not running";
                logger.error(this.connectionError);
            }
        } catch (error) {
            logger.error(`Error setting up QLab client: ${error.message}`);
            this.connectionError = `Error: ${error.message}`;
        }
    }

    async updateCueInfo() {
        const now = Date.now();
        if (now - this.lastCueUpdate < this.cacheTimeout) {
            logger.debug('Using cached cue info');
            return;
        }
        try {
            // Fetch both current and next cue in one AppleScript call
            const result = await this.client.getCueInfo();
            if (Array.isArray(result) && result.length >= 8) {
                this.currentSelectedCue = {
                    id: result[0],
                    number: result[1] || "--",
                    name: result[2] || "No selection",
                    type: result[3] || "unknown"
                };
                this.nextCue = {
                    id: result[4],
                    number: result[5] || "--",
                    name: result[6] || "No next cue",
                    type: result[7] || "unknown"
                };
            } else if (Array.isArray(result) && result[0] === 'error') {
                throw new Error(result[1]);
            } else {
                // Fallback: no data
                this.currentSelectedCue = { number: "--", name: "No selection", type: "unknown" };
                this.nextCue = { number: "--", name: "No next cue", type: "unknown" };
            }
            this.lastCueUpdate = now;
        } catch (error) {
            logger.error(`Error in updateCueInfo: ${error.message}`);
            this.currentSelectedCue = { number: "ERR", name: `Error: ${error.message.substring(0, 30)}`, type: "error" };
            this.nextCue = { number: "ERR", name: "Error", type: "error" };
        }
    }

    async getCurrentSelectedCue() {
        // Don't call updateCueInfo here - let it be called periodically
        return this.currentSelectedCue;
    }

    async getNextCue() {
        // Don't call updateCueInfo here - let it be called periodically  
        return this.nextCue;
    }

    async play() {
        try {
            // Invalidate cache for immediate response
            this.client.invalidateCache();
            const success = await this.client.go();
            if (success) {
                // Trigger async update without blocking
                setImmediate(() => this.updateCueInfo());
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async stop() {
        try {
            // Invalidate cache for immediate response
            this.client.invalidateCache();
            const success = await this.client.stop();
            if (success) {
                setImmediate(() => this.updateCueInfo());
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async next() {
        try {
            // Invalidate cache for immediate response
            this.client.invalidateCache();
            const success = await this.client.next();
            if (success) {
                setImmediate(() => this.updateCueInfo());
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async previous() {
        try {
            // Invalidate cache for immediate response
            this.client.invalidateCache();
            const success = await this.client.previous();
            if (success) {
                setImmediate(() => this.updateCueInfo());
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async panic() {
        try {
            return await this.client.panic();
        } catch (error) {
            return false;
        }
    }

    async reset() {
        try {
            const success = await this.client.reset();
            if (success) {
                setImmediate(() => this.updateCueInfo());
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async skipToCue(cueId) {
        try {
            // Debounce rapid selections of the same cue
            const now = Date.now();
            if (this.lastSelectedCueId === cueId && (now - this.lastSelectionTime) < 500) {
                logger.debug(`Ignoring rapid duplicate selection of cue: ${cueId}`);
                return true; // Return success but don't actually send
            }
            
            // Use the correct QLab OSC format: /select_id/{uniqueID}
            // This matches the C# qController implementation
            const address = this.client.currentWorkspaceId 
                ? `/workspace/${this.client.currentWorkspaceId}/select_id/${cueId}`
                : `/select_id/${cueId}`;
            
            logger.info(`Selecting cue with ID: ${cueId} using address: ${address}`);
            await this.client.sendOSCMessage(address, [], false);
            
            // Track last selection for debouncing
            this.lastSelectedCueId = cueId;
            this.lastSelectionTime = now;
            
            logger.info(`✅ Cue selection sent: ${cueId}`);
            return true;
        } catch (error) {
            logger.error(`Exception in skipToCue: ${error.message}`);
            return false;
        }
    }



    cleanup() {
        // No cleanup needed for AppleScript
    }

    async getAllCues() {
        const now = Date.now();
        const cuesCacheTimeout = 10000; // 10 seconds - increased for stability
        
        // Check global cache first (survives client disconnections)
        const globalCache = globalCueCache.get(this.workspaceId);
        if (globalCache && now - globalCache.lastUpdate < cuesCacheTimeout) {
            logger.debug(`Using global cache for workspace ${this.workspaceId} (${globalCache.cues.length} cues)`);
            return globalCache.cues;
        }
        
        // Use instance cache if available and fresh
        if (this.cachedCues.length > 0 && now - this.lastCuesUpdate < cuesCacheTimeout) {
            return this.cachedCues;
        }
        
        // Fetch fresh cues and cache them both locally and globally
        const cues = await this.client.getAllCues();
        this.cachedCues = cues;
        this.lastCuesUpdate = now;
        
        // Update global cache
        globalCueCache.set(this.workspaceId, {
            cues: cues,
            lastUpdate: now
        });
        
        logger.info(`Cached ${cues.length} cues for workspace ${this.workspaceId}`);
        return cues;
    }
}

// Utility functions
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

// Separate instances from workspaces following qController pattern  
async function discoverQLabInstances() {
    logger.info('Starting QLab instance discovery...');
    
    return new Promise((resolve) => {
        try {
            const bonjourService = safeRequire('bonjour-service');
            const bonjourInstance = new bonjourService.default();
            let foundInstances = [];
            
            logger.info('Searching for QLab services via Bonjour/Zeroconf...');
            
            // Browse for QLab services
            const browser = bonjourInstance.find({ type: 'qlab', protocol: 'tcp' });
            
            browser.on('up', (service) => {
                logger.info(`Found QLab instance: ${service.name} at ${service.referer.address}:${service.port}`);
                
                foundInstances.push({
                    name: service.name,
                    ip: service.referer.address,
                    port: service.port,
                    hostname: service.name
                });
            });

            browser.on('error', (err) => {
                logger.error(`Bonjour browser error: ${err.message}`);
            });

            // Wait for discovery to complete
            setTimeout(() => {
                browser.stop();
                
                if (foundInstances.length > 0) {
                    discoveredInstances = foundInstances;
                    logger.info(`Found ${discoveredInstances.length} QLab instance(s) via Bonjour`);
                    resolve({ instances: discoveredInstances, error: null });
                } else {
                    // Try fallback to localhost
                    logger.warn("No QLab instances found via Bonjour, trying localhost fallback");
                    discoveredInstances = [{
                        name: "QLab (localhost)",
                        ip: "127.0.0.1", 
                        port: 53000,
                        hostname: "localhost"
                    }];
                    resolve({ instances: discoveredInstances, error: null });
                }
            }, 2000); // Give Bonjour 2 seconds to find services
            
        } catch (error) {
            logger.error(`Failed to discover QLab instances: ${error.message}`);
            discoveredInstances = [];
            resolve({ instances: [], error: `Discovery error: ${error.message}` });
        }
    });
}

// Function to get workspaces from a specific discovered QLab instance
async function getWorkspacesFromInstance(instanceIndex) {
    logger.info(`Getting workspaces from instance ${instanceIndex}...`);
    
    if (instanceIndex >= discoveredInstances.length) {
        throw new Error("Invalid instance index");
    }
    
    const instance = discoveredInstances[instanceIndex];
    logger.info(`Connecting to ${instance.name} at ${instance.ip}:${instance.port} to get workspaces`);
    
    try {
        // Create a temporary client to query this specific QLab instance
        const tempClient = new QLabOSCClient(instance.ip, instance.port);
        
        // Wait for initialization
        await new Promise(resolve => {
            const checkInit = () => {
                if (tempClient.oscPort) {
                    resolve();
                } else {
                    setTimeout(checkInit, 100);
                }
            };
            checkInit();
        });
        
        // Get workspaces from this instance
        const workspaces = await tempClient.getWorkspaces();
        
        // Clean up the temporary client
        tempClient.cleanup();
        
        logger.info(`Retrieved ${workspaces.length} workspaces from instance ${instance.name}`);
        return workspaces;
        
    } catch (error) {
        logger.error(`Error getting workspaces from ${instance.name}: ${error.message}`);
        throw error;
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/instances', async (req, res) => {
    try {
        const { instances, error } = await discoverQLabInstances();
        if (error) {
            return res.json({ success: false, error });
        }
        res.json({ success: true, instances });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/refresh_instances', async (req, res) => {
    try {
        const { instances, error } = await discoverQLabInstances();
        if (error) {
            return res.json({ success: false, error });
        }
        res.json({
            success: true,
            instances,
            message: `Found ${instances.length} workspace(s)`
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/instances/:instanceIndex/workspaces', async (req, res) => {
    try {
        const instanceIndex = parseInt(req.params.instanceIndex);
        const workspaces = await getWorkspacesFromInstance(instanceIndex);
        res.json({
            success: true,
            workspaces,
            message: `Found ${workspaces.length} workspace(s)`
        });
    } catch (error) {
        logger.error(`Error getting workspaces for instance ${req.params.instanceIndex}: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Helper function to get client ID from request
function getClientId(req) {
    return req.headers['x-client-id'] || req.headers['x-socket-id'] || 'default';
}

// Workspace connection pool management
async function getOrCreateWorkspaceConnection(workspaceId, instanceInfo) {
    let poolEntry = workspacePool.get(workspaceId);
    
    if (!poolEntry) {
        // Create new shared connection
        logger.info(`Creating new shared workspace connection for: ${workspaceId}`);
        const client = new QLabClientWrapper(workspaceId);
        await client.initialize();
        
        if (client.connectionError || !client.connected) {
            throw new Error(client.connectionError || "Failed to connect to QLab workspace");
        }
        
        poolEntry = {
            client: client,
            refCount: 0,
            clients: new Set(),
            instanceInfo: instanceInfo
        };
        workspacePool.set(workspaceId, poolEntry);
    }
    
    return poolEntry;
}

function addClientToWorkspace(clientId, workspaceId) {
    const poolEntry = workspacePool.get(workspaceId);
    if (poolEntry) {
        poolEntry.clients.add(clientId);
        poolEntry.refCount++;
        logger.info(`Added client ${clientId} to workspace ${workspaceId} (refs: ${poolEntry.refCount})`);
    }
}

function removeClientFromWorkspace(clientId, workspaceId) {
    const poolEntry = workspacePool.get(workspaceId);
    if (poolEntry) {
        poolEntry.clients.delete(clientId);
        poolEntry.refCount--;
        logger.info(`Removed client ${clientId} from workspace ${workspaceId} (refs: ${poolEntry.refCount})`);
        
        // Clean up workspace connection if no more clients
        if (poolEntry.refCount <= 0) {
            logger.info(`Cleaning up workspace connection for: ${workspaceId}`);
            try {
                poolEntry.client.cleanup();
            } catch (error) {
                logger.error(`Error cleaning up workspace ${workspaceId}: ${error.message}`);
            }
            workspacePool.delete(workspaceId);
        }
    }
}

function getWorkspaceClient(workspaceId) {
    const poolEntry = workspacePool.get(workspaceId);
    return poolEntry ? poolEntry.client : null;
}

app.post('/api/connect/:instanceId/:workspaceId', async (req, res) => {
    const instanceId = parseInt(req.params.instanceId);
    const workspaceId = req.params.workspaceId;
    const clientId = getClientId(req);
    
    if (instanceId < 0 || instanceId >= discoveredInstances.length) {
        return res.json({ success: false, error: "Invalid instance ID" });
    }
    
    // Get or create client connection data
    let clientData = clientConnections.get(clientId);
    if (!clientData) {
        clientData = {
            workspaceId: null,
            selectedCue: { number: "", name: "" },
            nextCue: { number: "", name: "" }
        };
        clientConnections.set(clientId, clientData);
    }
    
    // Disconnect from any existing workspace connection for this client
    if (clientData.workspaceId) {
        removeClientFromWorkspace(clientId, clientData.workspaceId);
        clientData.workspaceId = null;
    }
    
    try {
        const instance = discoveredInstances[instanceId];
        logger.info(`Connecting to QLab instance: ${instance.name} at ${instance.ip}:${instance.port}, workspace: ${workspaceId}`);
        
        // Create a custom QLabOSCClient for this specific instance
        const customClient = new QLabOSCClient(instance.ip, instance.port);
        
        // Wait for initialization
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
            const checkInit = () => {
                if (customClient.oscPort) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    setTimeout(checkInit, 100);
                }
            };
            checkInit();
        });
        
        // Set the workspace
        await customClient.setActiveWorkspace(workspaceId);
        
        // Create wrapper with the custom client
        const clientWrapper = new QLabClientWrapper(workspaceId);
        clientWrapper.client = customClient; // Replace the default client
        await clientWrapper.initialize();
        
        if (clientWrapper.connectionError || !clientWrapper.connected) {
            throw new Error(clientWrapper.connectionError || "Failed to connect to workspace");
        }
        
        // Get or create workspace pool entry
        let poolEntry = workspacePool.get(workspaceId);
        if (!poolEntry) {
            poolEntry = {
                client: clientWrapper,
                refCount: 0,
                clients: new Set(),
                instanceInfo: {
                    ...instance,
                    workspace_id: workspaceId,
                    workspace_name: `Workspace ${workspaceId}`
                }
            };
            workspacePool.set(workspaceId, poolEntry);
        }
        
        // Add this client to the workspace
        addClientToWorkspace(clientId, workspaceId);
        clientData.workspaceId = workspaceId;
        
        // Get initial cue data
        clientData.selectedCue = await clientWrapper.getCurrentSelectedCue();
        clientData.nextCue = await clientWrapper.getNextCue();
        
        logger.info(`Successfully connected to ${instance.name} - Workspace: ${workspaceId} for client ${clientId}`);
        res.json({
            success: true,
            name: `${instance.name} - Workspace ${workspaceId}`,
            ip: instance.ip || "localhost",
            workspace_id: workspaceId,
            currentCue: clientData.selectedCue,
            nextCue: clientData.nextCue
        });
        
        // Send initial cue info to this client
        setTimeout(() => {
            updateCueInfoForClient(clientId);
        }, 100);
        
        // Fetch and emit cue list asynchronously
        setImmediate(async () => {
            try {
                const cues = await clientWrapper.getAllCues();
                io.to(clientId).emit('cueList', { cues });
                logger.info(`Emitted ${cues.length} cues to client ${clientId}`);
            } catch (error) {
                logger.warn(`Failed to fetch cues on connection: ${error.message}`);
            }
        });
        
    } catch (error) {
        logger.error(`Error connecting to workspace ${workspaceId}: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/connect/:instanceId', async (req, res) => {
    const instanceId = parseInt(req.params.instanceId);
    const clientId = getClientId(req);
    
    if (instanceId < 0 || instanceId >= discoveredInstances.length) {
        return res.json({ success: false, error: "Invalid instance ID" });
    }
    
    // Get or create client connection data
    let clientData = clientConnections.get(clientId);
    if (!clientData) {
        clientData = {
            workspaceId: null,
            selectedCue: { number: "", name: "" },
            nextCue: { number: "", name: "" }
        };
        clientConnections.set(clientId, clientData);
    }
    
    // Disconnect from any existing workspace connection for this client
    if (clientData.workspaceId) {
        removeClientFromWorkspace(clientId, clientData.workspaceId);
        clientData.workspaceId = null;
    }
    
    try {
        const instance = discoveredInstances[instanceId];
        logger.info(`Connecting to QLab instance: ${instance.name} at ${instance.ip}:${instance.port}`);
        
        // Get workspaces from this instance
        const workspaces = await getWorkspacesFromInstance(instanceId);
        
        if (workspaces.length === 0) {
            return res.json({ success: false, error: "No workspaces found in this QLab instance" });
        }
        
        // For now, connect to the first workspace found
        // TODO: In the future, we could show a workspace selector
        const workspace = workspaces[0];
        logger.info(`Found ${workspaces.length} workspace(s), connecting to: ${workspace.displayName || workspace.name}`);
        logger.info(`Workspace object:`, JSON.stringify(workspace, null, 2));
        
        // Get or create shared workspace connection - use id from transformed workspace
        const workspaceId = (workspace.id && workspace.id !== "") ? workspace.id : 
                           (workspace.uniqueID && workspace.uniqueID !== "") ? workspace.uniqueID : 
                           (workspace.workspace_id && workspace.workspace_id !== "") ? workspace.workspace_id : null;
        logger.info(`Extracted workspaceId: ${workspaceId}`);
        const poolEntry = await getOrCreateWorkspaceConnection(workspaceId, {
            ...instance,
            workspace_id: workspaceId,
            workspace_name: workspace.displayName || workspace.name
        });
        
        // Add this client to the workspace
        addClientToWorkspace(clientId, workspaceId);
        clientData.workspaceId = workspaceId;
        
        // Get initial cue data for this client from shared connection
        const client = poolEntry.client;
        clientData.selectedCue = await client.getCurrentSelectedCue();
        clientData.nextCue = await client.getNextCue();
        
        // Respond immediately without waiting for cue list
        logger.info(`Successfully connected to ${instance.name} - Workspace: ${workspace.name} for client ${clientId}`);
        res.json({
            success: true,
            name: `${instance.name} - ${workspace.displayName || workspace.name}`,
            ip: instance.ip || "localhost",
            workspace_id: workspaceId,
            currentCue: clientData.selectedCue,
            nextCue: clientData.nextCue
        });
        
        // Send initial cue info to this client
        setTimeout(() => {
            updateCueInfoForClient(clientId);
        }, 100);
        
        // Fetch and emit cue list asynchronously in the background (non-blocking)
        setImmediate(async () => {
            try {
                const cues = await client.getAllCues();
                io.to(clientId).emit('cueList', { cues });
                logger.info(`Emitted ${cues.length} cues to client ${clientId}`);
            } catch (error) {
                logger.warn(`Failed to fetch cues on connection: ${error.message}`);
            }
        });
    } catch (error) {
        logger.error(`Error connecting to QLab instance: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/connect_direct', async (req, res) => {
    const clientId = getClientId(req);
    
    try {
        // Get or create client connection data
        let clientData = clientConnections.get(clientId);
        if (!clientData) {
            clientData = {
                workspaceId: null,
                selectedCue: { number: "", name: "" },
                nextCue: { number: "", name: "" }
            };
            clientConnections.set(clientId, clientData);
        }
        
        // Disconnect from any existing workspace connection for this client
        if (clientData.workspaceId) {
            removeClientFromWorkspace(clientId, clientData.workspaceId);
            clientData.workspaceId = null;
        }
        
        logger.info('Attempting direct connection to QLab...');
        
        const workspaceId = "default";
        const instance = {
            name: "QLab - Default Workspace",
            ip: "localhost",
            port: 0,
            hostname: "localhost",
            id: 0,
            workspace_id: workspaceId
        };
        
        // Get or create shared workspace connection
        const poolEntry = await getOrCreateWorkspaceConnection(workspaceId, instance);
        
        // Add this client to the workspace
        addClientToWorkspace(clientId, workspaceId);
        clientData.workspaceId = workspaceId;
        
        // Get initial cue data for this client from shared connection
        const client = poolEntry.client;
        clientData.selectedCue = await client.getCurrentSelectedCue();
        clientData.nextCue = await client.getNextCue();
        
        // Respond immediately without waiting for cue list
        logger.info(`Successfully connected to QLab via direct connection for client ${clientId}`);
        res.json({
            success: true,
            name: "QLab - Default Workspace",
            ip: "localhost",
            workspace_id: workspaceId,
            currentCue: clientData.selectedCue,
            nextCue: clientData.nextCue
        });
        
        // Send initial cue info to this client
        setTimeout(() => {
            updateCueInfoForClient(clientId);
        }, 100);
        
        // Fetch and emit cue list asynchronously in the background (non-blocking)
        setImmediate(async () => {
            try {
                const cues = await client.getAllCues();
                io.to(clientId).emit('cueList', { cues });
                logger.info(`Emitted ${cues.length} cues to client ${clientId}`);
            } catch (error) {
                logger.warn(`Failed to fetch cues on direct connection: ${error.message}`);
            }
        });
    } catch (error) {
        logger.error(`Error in direct connection: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/disconnect', (req, res) => {
    const clientId = getClientId(req);
    const clientData = clientConnections.get(clientId);
    
    if (clientData && clientData.workspaceId) {
        try {
            logger.info(`Disconnecting client ${clientId} from workspace ${clientData.workspaceId}`);
            removeClientFromWorkspace(clientId, clientData.workspaceId);
        } catch (error) {
            logger.error(`Error during disconnect for client ${clientId}: ${error.message}`);
        }
    }
    
    // Reset client connection data
    if (clientData) {
        clientData.workspaceId = null;
        clientData.selectedCue = { number: "", name: "" };
        clientData.nextCue = { number: "", name: "" };
    }
    
    res.json({ success: true });
});

app.post('/api/command/:command', async (req, res) => {
    const clientId = getClientId(req);
    const clientData = clientConnections.get(clientId);
    
    if (!clientData || !clientData.workspaceId) {
        return res.json({ success: false, error: "Not connected to any QLab instance" });
    }
    
    const command = req.params.command;
    const client = getWorkspaceClient(clientData.workspaceId);
    
    if (!client) {
        return res.json({ success: false, error: "Workspace connection lost" });
    }
    const startTime = Date.now();
    
    try {
        let success = false;
        let errorMsg = null;
        
        switch (command) {
            case "play":
                success = await client.play();
                break;
            case "stop":
                success = await client.stop();
                break;
            case "next":
                success = await client.next();
                break;
            case "previous":
                success = await client.previous();
                break;
            case "panic":
                success = await client.panic();
                break;
            case "reset":
                success = await client.reset();
                break;
            case "panic":
                success = await client.panic();
                break;
            default:
                success = false;
                errorMsg = `Unknown command: ${command}`;
        }
        
        const latencyMs = Date.now() - startTime;
        
        // Update performance counters
        commandsSent++;
        totalLatencyMs += latencyMs;
        if (!success) {
            errorCount++;
        }
        
        // Update cue info for all clients after successful navigation commands
        if (success && ['play', 'stop', 'next', 'previous', 'panic', 'reset'].includes(command)) {
            // Small delay to allow QLab to process the command before querying
            setTimeout(() => {
                updateAllClientsCueInfo();
            }, 100);
        }
        
        res.json({
            success,
            latency_ms: latencyMs,
            error: errorMsg
        });
    } catch (error) {
        const latencyMs = Date.now() - startTime;
        commandsSent++;
        totalLatencyMs += latencyMs;
        errorCount++;
        
        logger.error(`Error sending command ${command}: ${error.message}`);
        res.json({
            success: false,
            latency_ms: latencyMs,
            error: error.message
        });
    }
});

app.get('/api/cue_info', async (req, res) => {
    const clientId = getClientId(req);
    const clientData = clientConnections.get(clientId);
    
    if (!clientData || !clientData.workspaceId) {
        return res.json({ success: false, error: "Not connected to any QLab instance" });
    }
    
    const workspaceClient = getWorkspaceClient(clientData.workspaceId);
    if (!workspaceClient) {
        return res.json({ success: false, error: "Workspace connection not found" });
    }
    
    try {
        // Get current and next cue using the shared workspace client
        const currentCue = await workspaceClient.getCurrentSelectedCue();
        const nextCue = await workspaceClient.getNextCue();
        
        res.json({
            success: true,
            current: {
                number: currentCue.number || "N/A",
                name: currentCue.name || "Unnamed",
                type: currentCue.type || "Unknown"
            },
            next: {
                number: nextCue.number || "N/A",
                name: nextCue.name || "Unnamed",
                type: nextCue.type || "Unknown"
            }
        });
    } catch (error) {
        logger.error(`Error getting cue info: ${error.message}`);
        res.json({
            success: false,
            error: "Failed to get cue information"
        });
    }
});

app.get('/api/status', (req, res) => {
    const clientId = getClientId(req);
    const clientData = clientConnections.get(clientId);
    
    if (!clientData || !clientData.workspaceId) {
        return res.json({ success: false, error: "Not connected to any QLab instance" });
    }
    
    const current = {
        number: clientData.selectedCue?.number || "N/A",
        name: clientData.selectedCue?.name || "Unnamed",
        type: clientData.selectedCue?.type || "Unknown"
    };
    const next = {
        number: clientData.nextCue?.number || "N/A",
        name: clientData.nextCue?.name || "Unnamed",
        type: clientData.nextCue?.type || "Unknown"
    };
    const avg = commandsSent > 0 ? (totalLatencyMs / commandsSent) : 0.0;
    const errRate = commandsSent > 0 ? (errorCount / commandsSent * 100.0) : 0.0;
    res.json({
        success: true,
        current,
        next,
        performance: {
            average_latency: Math.round(avg * 10) / 10,
            commands_sent: commandsSent,
            error_rate: Math.round(errRate * 10) / 10
        }
    });
});

app.post('/api/skip', async (req, res) => {
    const clientId = getClientId(req);
    const clientData = clientConnections.get(clientId);
    
    if (!clientData || !clientData.workspaceId) {
        return res.json({ success: false, error: "Not connected" });
    }
    
    const cueId = req.body.cue;
    if (!cueId) {
        return res.json({ success: false, error: "No cue ID provided" });
    }
    
    const wrapper = getWorkspaceClient(clientData.workspaceId);
    
    if (!wrapper) {
        return res.json({ success: false, error: "Workspace connection lost" });
    }
    const startTime = Date.now();
    
    try {
        const success = await wrapper.skipToCue(cueId);
        const latencyMs = Date.now() - startTime;
        
        // Update cue info for all clients after successful cue selection
        if (success) {
            setTimeout(() => {
                updateAllClientsCueInfo();
            }, 100);
        }
        
        res.json({
            success,
            latency_ms: latencyMs
        });
    } catch (error) {
        const latencyMs = Date.now() - startTime;
        logger.error(`Exception in skip endpoint: ${error.message}`);
        res.json({
            success: false,
            latency_ms: latencyMs,
            error: error.message
        });
    }
});

app.get('/api/cues', async (req, res) => {
    const clientId = getClientId(req);
    let clientData = clientConnections.get(clientId);
    
    // If client data doesn't exist, try to restore from any active workspace connection
    if (!clientData || !clientData.workspaceId) {
        // Check if there's an active workspace we can connect this client to
        for (const [workspaceId, connection] of workspacePool) {
            if (connection.client && connection.refs > 0) {
                logger.info(`Restoring client ${clientId} to active workspace ${workspaceId}`);
                // Create client data and add to workspace
                clientData = {
                    workspaceId: workspaceId,
                    selectedCue: { number: "", name: "" },
                    nextCue: { number: "", name: "" }
                };
                clientConnections.set(clientId, clientData);
                addClientToWorkspace(clientId, workspaceId);
                break;
            }
        }
        
        // If still no client data, return empty
        if (!clientData || !clientData.workspaceId) {
            return res.json({ cues: [] });
        }
    }
    
    const client = getWorkspaceClient(clientData.workspaceId);
    if (!client) {
        return res.json({ cues: [] });
    }
    
    try {
        const cues = await client.getAllCues();
        res.json({ cues });
    } catch (error) {
        logger.error(`Error getting cues for client ${clientId}: ${error.message}`);
        res.json({ cues: [] });
    }
});

// Clear performance metrics endpoint
app.post('/api/clear_performance', (req, res) => {
    commandsSent = 0;
    errorCount = 0;
    totalLatencyMs = 0.0;
    globalBackoffUntil = 0;
    logger.info("Performance metrics manually cleared");
    
    // Immediately broadcast cleared metrics to all connected clients
    io.emit('performance', {
        average_latency: 0.0,
        commands_sent: 0,
        error_rate: 0.0
    });
    
    res.json({ 
        success: true, 
        message: "Performance metrics cleared",
        performance: {
            average_latency: 0.0,
            commands_sent: 0,
            error_rate: 0.0
        }
    });
});

// Removed old periodic update function - now using per-client version below

// On-demand cue info update function - only called when needed to prevent OSC timeouts
async function updateCueInfoForClient(socketId) {
    const clientData = clientConnections.get(socketId);
    if (!clientData || !clientData.workspaceId) return;
    
    const client = getWorkspaceClient(clientData.workspaceId);
    if (!client) return;
    
    try {
        logger.info(`Updating cue info for client ${socketId}`);
        
        // Get current and next cue info using shared workspace connection
        const currentCue = await client.client.getSelectedCue();
        const nextCue = await client.client.getNextCue();
        
        // Update client-specific data
        if (currentCue) clientData.selectedCue = currentCue;
        if (nextCue) clientData.nextCue = nextCue;
        
        // Send update to this specific client only
        const update = {
            current: currentCue || null,
            next: nextCue || null,
            timestamp: Date.now()
        };
        
        io.to(socketId).emit('cueInfo', update);
        logger.info(`Cue info sent to client ${socketId}:`, JSON.stringify(update, null, 2));
        
    } catch (error) {
        logger.warn(`Cue info update error for client ${socketId}: ${error.message}`);
        // Send empty state on error
        io.to(socketId).emit('cueInfo', {
            current: null,
            next: null,
            error: error.message,
            timestamp: Date.now()
        });
    }
}

// Update all connected clients with current cue info (called after navigation commands)
// Debounced update function to prevent flooding QLab with requests
let updateTimeout = null;
const UPDATE_DEBOUNCE_MS = 500; // Wait 500ms before sending updates to prevent flooding

async function updateAllClientsCueInfo() {
    // Clear any existing timeout
    if (updateTimeout) {
        clearTimeout(updateTimeout);
    }
    
    // Debounce the actual update to prevent flooding QLab
    updateTimeout = setTimeout(async () => {
        logger.debug(`Debounced cue info update for ${clientConnections.size} clients`);
        
        for (const socketId of clientConnections.keys()) {
            await updateCueInfoForClient(socketId);
        }
        
        // Send performance stats to all clients (shared metrics)
        const avg = commandsSent > 0 ? (totalLatencyMs / commandsSent) : 0.0;
        const errRate = commandsSent > 0 ? (errorCount / commandsSent * 100.0) : 0.0;
        io.emit('performance', {
            average_latency: Math.round(avg * 10) / 10,
            commands_sent: commandsSent,
            error_rate: Math.round(errRate * 10) / 10
        });
        
        updateTimeout = null;
    }, UPDATE_DEBOUNCE_MS);
}

// Start server
function startServer() {
    // Reset performance metrics on server start
    commandsSent = 0;
    errorCount = 0;
    totalLatencyMs = 0.0;
    globalBackoffUntil = 0;
    logger.info("Performance metrics cleared on server start");
    
    // Broadcast cleared performance metrics to all clients after a short delay
    setTimeout(() => {
        io.emit('performance', {
            average_latency: 0.0,
            commands_sent: 0,
            error_rate: 0.0
        });
        logger.info("Broadcasted cleared performance metrics to clients");
    }, 1000);
    
    logger.info("Starting QOnCommand - QLab Remote control application");
    logger.info(`Web interface will be available at http://localhost:${WEB_PORT}`);
    
    // Get the local IP address to show a more useful URL
    try {
        const localIp = getLocalIpAddress();
        logger.info(`Local network access: http://${localIp}:${WEB_PORT}`);
    } catch (error) {
        logger.warn(`Could not determine local IP: ${error.message}`);
    }
    
    // Start with an AppleScript-based discovery
    discoverQLabInstances();
    // Static middleware already configured above

    // Only update cue info on demand (when QLab sends updates) to prevent OSC timeouts
    // The periodic update approach was causing OSC timeout cascades
    logger.info("Event-driven cue updates enabled - no periodic polling to prevent OSC timeouts");
    
    // Initial cue info fetch only when clients first connect (handled in socket connection)

    server.listen(WEB_PORT, '0.0.0.0', () => {
        logger.info(`Server listening on port ${WEB_PORT}`);
        logger.info(`Open your browser and navigate to http://localhost:${WEB_PORT}`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Keyboard interrupt received, shutting down...');
    gracefulShutdown();
});

process.on('SIGTERM', () => {
    logger.info('Termination signal received, shutting down...');
    gracefulShutdown();
});

function gracefulShutdown() {
    logger.info('Starting graceful shutdown...');
    
    // Close server connections
    if (server) {
        server.close(() => {
            logger.info('HTTP server closed');
        });
    }
    
    // Close socket.io connections
    if (io) {
        io.close(() => {
            logger.info('Socket.IO server closed');
        });
    }
    
    // Cleanup all workspace connections
    try {
        for (const [workspaceId, poolEntry] of workspacePool.entries()) {
            try {
                poolEntry.client.cleanup();
                logger.info(`Cleaned up workspace connection: ${workspaceId}`);
            } catch (error) {
                logger.error(`Error cleaning up workspace ${workspaceId}: ${error.message}`);
            }
        }
        workspacePool.clear();
        clientConnections.clear();
        logger.info('All workspace connections cleaned up');
    } catch (error) {
        logger.error(`Error during workspace cleanup: ${error.message}`);
    }
    
    // Force exit after 3 seconds if graceful shutdown hangs
    setTimeout(() => {
        logger.warn('Forceful shutdown after timeout');
        process.exit(0);
    }, 3000);
    
    // Exit normally
    process.exit(0);
}

// Start the application only if this file is run directly
if (require.main === module) {
    startServer();
}

module.exports = { 
    app, 
    server,
    startServer: startServer,
    logger: logger 
};
