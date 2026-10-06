// The Jordan Lake areas JordanWatch gives a verdict for, north to south.
//   cyanPointId      = which point in cyan.json holds this area's satellite
//                      reading (Robeson Creek has none and borrows Vista Point's)
//   onshoreWindFrom  = the compass direction (degrees) wind blows FROM when it
//                      pushes floating scum onto this shore; null = no single shore
//   lat/lng          = the area's shore or boat ramp, for the map later
// Shore directions decided Oct 5 (from each beach toward its offshore point).

export const AREAS = [
  { id: "north", name: "Upper New Hope Arm", cyanPointId: "north", onshoreWindFrom: null, lat: 35.81, lng: -78.99 },
  { id: "crosswinds", name: "Crosswinds", cyanPointId: "crosswinds", onshoreWindFrom: 285, lat: 35.7443, lng: -78.9954 },
  { id: "parkers-creek", name: "Parkers Creek", cyanPointId: "parkers-creek", onshoreWindFrom: 80, lat: 35.7432, lng: -79.0433 },
  { id: "white-oak", name: "White Oak", cyanPointId: "white-oak", onshoreWindFrom: 280, lat: 35.7409, lng: -79.0156 },
  { id: "seaforth", name: "Seaforth", cyanPointId: "seaforth", onshoreWindFrom: 75, lat: 35.7258, lng: -79.0336 },
  { id: "poplar-point", name: "Poplar Point", cyanPointId: "poplar-point", onshoreWindFrom: 260, lat: 35.7227, lng: -79.0205 },
  { id: "ebenezer-church", name: "Ebenezer Church", cyanPointId: "ebenezer-church", onshoreWindFrom: 270, lat: 35.7068, lng: -79.0254 },
  { id: "vista-point", name: "Vista Point", cyanPointId: "vista-point", onshoreWindFrom: 85, lat: 35.7024, lng: -79.0510 },
  { id: "robeson-creek", name: "Robeson Creek", cyanPointId: "vista-point", onshoreWindFrom: null, lat: 35.7034, lng: -79.1002 },
  { id: "new-hope-overlook", name: "New Hope Overlook", cyanPointId: "new-hope-overlook", onshoreWindFrom: 25, lat: 35.6846, lng: -79.0457 }
];
