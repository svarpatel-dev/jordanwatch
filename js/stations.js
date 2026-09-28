// The stations JordanWatch shows, grouped by tier.
//   full    = live DO + turbidity → full risk badge
//   partial = live DO + pH, no turbidity → High or baseline Caution, never Low Risk
//   limited = flow / lake level only → readings shown, no badge
// lat/lng are from USGS and will be used by the map and "nearest station" later.

export const STATIONS = [
  // --- Full data ---
  { id: "03451500", name: "French Broad River at Asheville", tier: "full", lat: 35.6089, lng: -82.5781 },
  { id: "03512000", name: "Oconaluftee River at Birdtown", tier: "full", lat: 35.4614, lng: -83.3536 },

  // --- Partial data ---
  { id: "02101726", name: "Rocky River near Siler City", tier: "partial", lat: 35.7351, lng: -79.4231 },

  // --- Limited data (Jordan Lake area) ---
  { id: "02098197", name: "Jordan Lake at the Dam", tier: "limited", lat: 35.6547, lng: -79.0683 },
  { id: "02096960", name: "Haw River near Bynum", tier: "limited", lat: 35.7653, lng: -79.1358 },
  { id: "02097314", name: "New Hope Creek near Blands", tier: "limited", lat: 35.8850, lng: -78.9653 },
  { id: "02097517", name: "Morgan Creek near Chapel Hill", tier: "limited", lat: 35.8933, lng: -79.0197 },
  { id: "0209741955", name: "Northeast Creek near Genlee", tier: "limited", lat: 35.8722, lng: -78.9131 },
  { id: "0209782609", name: "White Oak Creek near Green Level", tier: "limited", lat: 35.7603, lng: -78.9203 },
  { id: "02098206", name: "Haw River near Moncure (below dam)", tier: "limited", lat: 35.6322, lng: -79.0600 },
  { id: "02096500", name: "Haw River at Haw River", tier: "limited", lat: 36.0872, lng: -79.3661 },
  { id: "02102000", name: "Deep River at Moncure", tier: "limited", lat: 35.6269, lng: -79.1161 },
  { id: "0209725960", name: "Third Fork Creek in Durham", tier: "limited", lat: 35.9512, lng: -78.9269 }
];
