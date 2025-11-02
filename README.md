# QOnCommand

**Professional web-based remote control for Figure53's QLab**

QOnCommand is a modern web-based remote control application for QLab, built with Node.js. Control your theatrical sound, lighting, and media cues remotely from any device on your network.

## ✨ Features

- **🎭 Real-time Control**: Play, stop, previous, next, panic, and reset commands with instant feedback
- **🔍 Auto-Discovery**: Automatic detection of QLab instances on your network via Bonjour/Zeroconf
- **🏢 Multi-Workspace**: Connect to multiple QLab workspaces and instances seamlessly
- **📊 Performance Monitoring**: Track command latency, success rates, and system performance
- **🎨 Modern UI**: Beautiful, responsive interface built with Tailwind CSS and glassmorphism design
- **📱 Mobile-Friendly**: Optimized for tablets and smartphones with touch-friendly controls
- **💻 Cross-Platform**: Works on macOS, Windows, and Linux (Well, it SHOULD be... I only tested it on macOS)
- **🎵 Cue Management**: View current/next cue info and jump to specific cues
- **⚡ Real-time Updates**: Live cue information via WebSocket connections

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser to `http://localhost:7522`

## Available Commands

- `npm start` - Start web server
- `npm run dev` - Start with nodemon for development  
- `npm run test-osc` - Test OSC connectivity

## Configuration

The application can be configured through environment variables:

- `WEB_PORT` - Server port (default: 7522)
- `LOG_LEVEL` - Logging verbosity (error, warn, info, debug)
- `LOG_TO_FILE` - Enable file logging (true/false)

## System Requirements

- Node.js 16.0.0 or higher
- QLab 4 or 5 (Figure53)
- Network connectivity to QLab instances

## Architecture

QOnCommand uses:
- **Express.js** for web server
- **Socket.io** for real-time communication
- **OSC** protocol for QLab communication
- **Bonjour/Zeroconf** for service discovery
- **Tailwind CSS** for modern UI styling

## Compatibility

- **QLab Versions**: QLab 4. (Untested on QLab 5)
- **Operating Systems**: macOS, Windows, Linux
- **Browsers**: Chrome, Firefox, Safari, Edge (modern browsers)

## Legal Notice

Figure 53® and QLab® are registered trademarks of Figure 53, LLC. QOnCommand is not affiliated with Figure 53, LLC and this application has not been reviewed nor is it approved by Figure 53, LLC.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.


## Why I made it: 

As an actor and the theatre company's resident sound manager, I can't be in two places at once. So I needed a tool to help me play sounds whilst rehersing on stage. At the time, there was something wrong with the qController app I used to use, so I thought I should make something until the app gets updated with a fix. 

Also, I wanted a bit of a project for myself. I built it using applescript first, but it was a bit slow and clunky. Then I only recently found that the app mentioned above was open sourced. [jwetzell's qController](https://github.com/jwetzell/qController), which fueled this version. 


## Atributions:

- [jwetzell's qController](https://github.com/jwetzell/qController): Without his work, this project would've just been purely applescript based, making it a "Mac Only" script. I've taken some notes on how he implemented his app. I then raged at Copilot to help me out. After probably 200+ "Lets fix this by implementing a method I think would work", I've got something functioning.  


## Support

QOnCommand is an open-source project. For issues, feature requests, or contributions, please use the project's issue tracker. But I quite honestly don't have time to maintain it myself, so don't expect me to fix any issues. 




