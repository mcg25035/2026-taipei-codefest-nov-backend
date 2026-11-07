// 約 500 公尺的網格。用固定網格而非隨機偏移，重複查詢才無法平均出真實位置。
const GRID_DEG = 0.005;

const snapValue = (v) => Number((Math.round(v / GRID_DEG) * GRID_DEG).toFixed(3));

export const snap = ({ lat, lng }) => ({ lat: snapValue(lat), lng: snapValue(lng) });

export function distanceM(a, b) {
  const R = 6_371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 公開距離一律由網格點計算並取到百公尺，避免被用來三角定位。
export const publicDistanceM = (viewer, approx) => Math.round(distanceM(snap(viewer), approx) / 100) * 100;
