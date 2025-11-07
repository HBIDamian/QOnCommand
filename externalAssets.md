# External Assets - Copyright & Licensing

This document outlines the external assets used in the QOnCommand project, their sources, and respective licensing information.

## CSS Frameworks

### Bootstrap 5
- **Asset**: `public/assets/css/bootstrap.min.css` & `public/assets/js/bootstrap.bundle.min.js`
- **Source**: https://getbootstrap.com/
- **Version**: 5.3.2 (minified)
- **License**: MIT License
- **Copyright**: Copyright (c) 2011-2023 The Bootstrap Authors
- **License URL**: https://github.com/twbs/bootstrap/blob/main/LICENSE
- **Usage**: Primary CSS framework and JavaScript components for responsive UI

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

### Bootstrap CDN
- **Source**: https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/
- **License**: MIT License
- **Usage**: Development reference and fallback (local files used in production)

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
- **Bootstrap**: No attribution required (MIT License)
- **Socket.IO**: No attribution required (MIT License)

## Asset Versions & Updates

This document reflects the asset versions as of November 5, 2025. When updating any external assets, please:

1. Verify the license compatibility
2. Update version numbers in this document
3. Check for any new attribution requirements
4. Test functionality with new versions

## Local Asset Sources

All local assets were downloaded from their official sources:
- Bootstrap: Downloaded from official CDN (CSS and JavaScript bundle)
- Inter Fonts: Downloaded from Google Fonts in WOFF2 format
- Socket.IO: Downloaded from official npm CDN

For the most current license information, please refer to the official project repositories and documentation linked above.