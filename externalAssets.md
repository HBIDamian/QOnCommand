# External Assets - Copyright & Licensing

This document outlines the external assets used in the QOnCommand project, their sources, and respective licensing information.

## CSS Frameworks

### Tailwind CSS
- **Asset**: `public/assets/css/tailwind.min.css`
- **Source**: https://tailwindcss.com/
- **Version**: 2.2.19 (minified)
- **License**: MIT License
- **Copyright**: Copyright (c) Tailwind Labs, Inc.
- **License URL**: https://github.com/tailwindlabs/tailwindcss/blob/master/LICENSE
- **Usage**: Primary CSS framework for application styling

## Fonts

### Inter Font Family
- **Assets**: 
  - `public/assets/fonts/Inter-Regular.woff2`
  - `public/assets/fonts/Inter-Medium.woff2`
  - `public/assets/fonts/Inter-SemiBold.woff2`
  - `public/assets/fonts/Inter-Bold.woff2`
- **Source**: https://fonts.google.com/specimen/Inter
- **Designer**: Rasmus Andersson
- **License**: SIL Open Font License 1.1
- **License URL**: https://scripts.sil.org/OFL
- **Usage**: Primary typeface for application interface

## JavaScript Libraries

### Socket.IO Client
- **Asset**: `public/assets/js/socket.io.min.js`
- **Source**: https://socket.io/
- **Version**: 4.x (client library)
- **License**: MIT License
- **Copyright**: Copyright (c) 2014-2023 Automattic <dev@cloudup.com>
- **License URL**: https://github.com/socketio/socket.io/blob/main/LICENSE
- **Usage**: Real-time bidirectional event-based communication

## CDN Resources (Development/Fallback)

### Tailwind CSS CDN
- **Source**: https://cdn.tailwindcss.com
- **License**: MIT License
- **Usage**: Development and styling reference (not included in production build)

### Google Fonts CDN
- **Source**: https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap
- **License**: SIL Open Font License 1.1
- **Usage**: Font loading during development (local fonts used in production)

## License Compliance

All external assets used in this project are licensed under permissive open-source licenses (MIT, SIL OFL 1.1) that allow:
- Commercial use
- Modification
- Distribution
- Private use

## Attribution Requirements

- **Inter Font**: No attribution required (SIL OFL 1.1)
- **Tailwind CSS**: No attribution required (MIT License)
- **Socket.IO**: No attribution required (MIT License)

## Asset Versions & Updates

This document reflects the asset versions as of November 5, 2025. When updating any external assets, please:

1. Verify the license compatibility
2. Update version numbers in this document
3. Check for any new attribution requirements
4. Test functionality with new versions

## Local Asset Sources

All local assets were downloaded from their official sources:
- Tailwind CSS: Downloaded from official CDN
- Inter Fonts: Downloaded from Google Fonts in WOFF2 format
- Socket.IO: Downloaded from official npm CDN

For the most current license information, please refer to the official project repositories and documentation linked above.