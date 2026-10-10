## Main UI

- Web-based horizontal situation indicator
- full screen view
- no screensaver
- high constrast (black background with white lines and text)
- Uses browser's Lon/Lat/Heading to determine current (origin) position
- User's plane is located at the origin (10% from bottom, centred)
- Top of browser window points same direction as direction of travel (instantaneous heading / best-fit line over last x lon/lat measurements)
- Target airfield at top of screen when plane is heading towards it
- Zoom adjusts dynamically so that the plane and target are always visible in the window when the plane is heading towards the target
- Villages / Towns / Cities shown as points on screen (names in/visiblebased on setting
- Vanilla JS if possible (framework suggestions welcome but must be approved)
- No CSS frameworks if possible (approval required)

## Adding / Selecting Airfields

- Airfields are defined on a separate UI page using the 4 coordinates of their pattern along with coordinates of the runway thresholds
- Airfields are drawn on / derrived from freely available satellite imagery

## Villages / towns / cities

- A static set of lat/lon points with a radius indicating their relative urban area and a name
- Island of Ireland only
