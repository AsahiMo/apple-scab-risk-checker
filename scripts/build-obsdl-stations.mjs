// obsdlの地点マスタ（stid/地点名/都道府県コード/観測要素フラグ/緯度経度/標高）を
// https://www.data.jma.go.jp/risk/obsdl/top/station から取得して1ファイルにまとめるスクリプト。
// 実行: node scripts/build-obsdl-stations.mjs
//
// 背景: JMA公式の amedastable.json（bosai系、ナウキャスト用）と obsdl（過去データ取得）の
// 地点番号は別体系（例: 東京はbosai=44132, obsdlのstid=s47662）で、単純な変換式がない。
// このスクリプトはobsdl側の正しい地点番号を直接収集する。

const PREF_CODES = [
  "11","13","12","17","15","16","14","22","20","18","24","21","19","23",
  "31","32","33","56","35","34","55","54","36","81","68","69","63","61",
  "57","52","48","42","41","40","67","66","60","49","43","84","85","82",
  "62","64","53","51","50","46","44","45","86","83","73","72","65","88",
  "87","74","71","91","99",
];

const STATION_RE = /title="([\s\S]*?)"[^>]*>\s*<input type="hidden" name="stid" value="([^"]*)">\s*<input type="hidden" name="stname" value="([^"]*)">\s*<input type="hidden" name="prid" value="([^"]*)">\s*<input type="hidden" name="kansoku" value="([^"]*)">/g;

function parseTitle(title) {
  const latM = title.match(/北緯：(\d+)度([\d.]+)分/);
  const sLatM = title.match(/南緯：(\d+)度([\d.]+)分/);
  const lonM = title.match(/東経：(\d+)度([\d.]+)分/);
  const altM = title.match(/標高：([\-\d.]+)m/);
  let lat = null;
  if (latM) lat = parseInt(latM[1], 10) + parseFloat(latM[2]) / 60;
  else if (sLatM) lat = -(parseInt(sLatM[1], 10) + parseFloat(sLatM[2]) / 60);
  const lon = lonM ? parseInt(lonM[1], 10) + parseFloat(lonM[2]) / 60 : null;
  const alt = altM ? parseFloat(altM[1]) : null;
  return {
    lat: lat !== null ? Math.round(lat * 1e5) / 1e5 : null,
    lon: lon !== null ? Math.round(lon * 1e5) / 1e5 : null,
    alt,
  };
}

async function fetchPref(pd) {
  const res = await fetch("https://www.data.jma.go.jp/risk/obsdl/top/station", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; AppleScabApp/1.0; +station-master-build)",
    },
    body: "pd=" + pd,
  });
  if (!res.ok) throw new Error(`pd=${pd} failed: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const result = {};
  for (const pd of PREF_CODES) {
    const html = await fetchPref(pd);
    let m;
    STATION_RE.lastIndex = 0;
    while ((m = STATION_RE.exec(html)) !== null) {
      const [, title, stid, stname, prid, kansoku] = m;
      // "h"始まりは地方全体などのグループ項目で実地点ではないので除外
      if (!stid || stid.startsWith("h") || result[stid]) continue;
      result[stid] = { name: stname, prid, kansoku, ...parseTitle(title) };
    }
    process.stdout.write(`pd=${pd} done, total=${Object.keys(result).length}\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return result;
}

const data = await main();
const fs = await import("node:fs");
const out = { generatedAt: new Date().toISOString(), source: "https://www.data.jma.go.jp/risk/obsdl/top/station", count: Object.keys(data).length, stations: data };
fs.writeFileSync(new URL("../amedastable_obsdl.json", import.meta.url), JSON.stringify(out, null, 0));
console.log("total stations:", Object.keys(data).length);
