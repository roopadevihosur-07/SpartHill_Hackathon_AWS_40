// Straight-line geometry. Amazon Location Service is not available on the event
// account, so drive distance and ETA are estimates (circuity factor + average speed).

const EARTH_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Estimated road km from straight-line km. */
export const roadKm = (km) => km * 1.3;

/** Estimated drive minutes (about 33 km/h average during an outage). */
export const driveMinutes = (km) => roadKm(km) / 0.55;

export const kmToMiles = (km) => km * 0.621371;

export const round1 = (n) => Math.round(n * 10) / 10;
