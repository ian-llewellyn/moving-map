## Main UI

- Web-based moving map instrument
- minimal visual components: plane, target airfield, other airfields, villages, towns and cities - no satellite imagery, no roads, no terrain
- full screen view
- no screensaver on main UI page
- must load offline (subsequent loads)
- high constrast (black background with white lines and text)
- Uses browser's Lon/Lat/Heading to determine current plane position
- User's plane is located 10% from bottom of the screen, centred
- Top of browser window points in heading direction if available (plane's nose), fallback to direction of travel (best-fit line over last x lat/lon observations)
- Target airfield selected pre-flight (from another UI page)
- Target airfield may be changed, with confirmation) during flight by tapping the newly desired airfield
- Target airfield's pattern is displayed for every airfield
- Zoom adjusts continuously so that the plane and target are visible in the window when the plane is heading towards the target
- Line showing ground track to nearest part of the pattern
- Villages, towns, cities and other airfields shown as points on screen (names (in)visible based on settings (separate UI page))
- Compass markers should 'slide' around the outer edge of the display (just the 10 degree figures)
- No other screen furniture for now
- Vanilla JS if possible (framework suggestions welcome but must be approved)
- No CSS frameworks if possible (approval required)
- No notice of licenses / uncertified for aviation use required in v1 (pre-release)

## Adding / Selecting Airfields

- Airfields are defined on a separate UI page using the 4 coordinates of their pattern's corners (in the direction of travel) along with the 2 coordinate sets of the runway thresholds
- Airfields are drawn on (manual tracing / click-on-map) freely available satellite imagery (separate UI page)
- Airfields are drawn while online, satellite imagery UI page does not need to work offline
- Personal use project - satellite imagery license should suit this use case
- Satellite imagery source should be selected primarily based on ease of integration
- Airfield data is stored in localStorage
- Separate runways treated as distinct airfields
- No import / export in v1

## Villages / towns / cities

- Data gathered once during project build - scripted update a bonus, but only if trivial
- A static set of lat/lon points with a radius in km indicating their relative urban area, and the name
- Island of Ireland only

## Deployment Platform

- Hosted on Github Pages (HTTPS accessible)
- Android Phone
- Chrome (and/or Firefox) Browser

## Exceptions

- Heading information not available / cannot be derived: backgrund flashes 50% red (1 Hz)
- If permissions are denied: Wake Lock API, GPS - the app does not need to consider fallback behaviour, just the ability to refresh+reseek permission
