const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    resetSettings: () => ipcRenderer.invoke('reset-settings'),
    checkDependencies: () => ipcRenderer.invoke('check-dependencies'),

    // Server control
    startServer: () => ipcRenderer.invoke('start-server'),
    stopServer: () => ipcRenderer.invoke('stop-server'),
    getServerStatus: () => ipcRenderer.invoke('get-server-status'),
    openWebInterface: () => ipcRenderer.invoke('open-web-interface'),

    // App info
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    getPerformanceStats: () => ipcRenderer.invoke('get-performance-stats'),

    // Utility
    checkPortAvailable: (port) => ipcRenderer.invoke('check-port-available', port),
    showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
    getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
    refreshLocalIP: () => ipcRenderer.invoke('get-local-ip'), // Refresh IP address

    // Event listeners
    onServerStatus: (callback) => {
        ipcRenderer.on('server-status', callback);
        // Return a function to remove the listener
        return () => ipcRenderer.removeListener('server-status', callback);
    },
    
    onServerLog: (callback) => {
        ipcRenderer.on('server-log', callback);
        return () => ipcRenderer.removeListener('server-log', callback);
    },

    // Remove all listeners (cleanup)
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners('server-status');
        ipcRenderer.removeAllListeners('server-log');
    }
});