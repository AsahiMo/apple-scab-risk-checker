// index.js — Cloudflare Worker
// 気象庁「過去の気象データ・ダウンロード」(obsdl) のプロキシAPI
//
// GET /api/amedas?station=s47662&from=20260601&to=20260630
//   station: obsdlの地点番号（stidそのもの。data/stations.jsonのキーと同じもの）
//     例: 東京（大手町、官署）= "s47662"、小河内（AMeDAS専用）= "a0365"
//     官署（気象台等）は "s" + 5桁、AMeDAS専用地点は "a" + 4桁のプレフィックス付き。
//     地点番号の詳細な仕様は README.md の「地点マスタ」を参照。
//   from, to: YYYYMMDD形式
//
// 返り値: { station, hourly: [{ datetime, temperature_c, precipitation_mm }, ...] }
//
// ============================================================================
// ⚠️ 重要：これは気象庁の公式APIではありません
// ============================================================================
// obsdlはAPIとして公式に仕様が公開されているものではなく、ブラウザ向けの
// データダウンロードページの内部リクエストを利用しています。将来的にページの
// 実装が変わると動作しなくなる可能性があります。デプロイ後は必ず値の妥当性
// （気温・降水量が現実的な範囲か）を確認してください。
//
// 本実装が前提とする仕様：
//  1. ELEMENT_CODE_* の値（気温・降水量の要素番号）
//     201=気温、101=降水量。
//
//  2. parseObsdlCsv() のCSV列の並び順
//     ymdLiteral="0"（年,月,日,時に分割）で取得した場合、CSVの列は
//     [年,月,日,時,気温,品質情報,均質番号,降水量,現象なし情報,品質情報,均質番号]
//     となり、列インデックス [year,month,day,hour,temperature,,,precipitation] で
//     取り出せる。
//     ※ ymdLiteral="1"（日付リテラル）にすると年月日時が「2026/8/1 1:00:00」の
//        ように1列に結合され、上記の列インデックスとズレるため使用しないこと。
// ============================================================================

const OBSDL_INDEX = "https://www.data.jma.go.jp/risk/obsdl/index.php";
const OBSDL_SHOW = "https://www.data.jma.go.jp/risk/obsdl/show/table";

// 要素番号（気温・降水量）
const ELEMENT_CODE_TEMPERATURE = "201";
const ELEMENT_CODE_PRECIPITATION = "101";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/amedas") {
      return new Response("Not found", { status: 404 });
    }

    const station = url.searchParams.get("station");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    if (!station || !from || !to) {
      return json({ error: "station, from, to は必須パラメータです" }, 400);
    }
    if (!/^(s\d{5}|a\d{4})$/.test(station)) {
      return json({ error: 'station は obsdlのstid形式（例: "s47662" や "a0365"）で指定してください' }, 400);
    }
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
      return json({ error: "from, to は YYYYMMDD 形式で指定してください" }, 400);
    }

    // 同じリクエストの繰り返しで気象庁側に負荷をかけないよう、Cache APIで簡易キャッシュ
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const csvText = await fetchObsdlCsv(station, from, to);
      const hourly = parseObsdlCsv(csvText);
      const response = json({ station, from, to, hourly });
      response.headers.set("Cache-Control", "public, max-age=21600"); // 6時間キャッシュ
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 502);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 本番では "*" ではなく自分のGitHub Pagesのオリジンに絞ることを推奨
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function fetchObsdlCsv(station, from, to) {
  // 1. セッションCookieを得るため index.php に一度アクセス
  const indexRes = await fetch(OBSDL_INDEX, { method: "GET" });
  const setCookie = indexRes.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";")[0]; // "PHPSESSID=xxxx" 部分だけ取り出す

  const fy = from.slice(0, 4), fm = String(Number(from.slice(4, 6))), fd = String(Number(from.slice(6, 8)));
  const ty = to.slice(0, 4), tm = String(Number(to.slice(4, 6))), td = String(Number(to.slice(6, 8)));

  const payload = {
    stationNumList: JSON.stringify([station]),
    aggrgPeriod: "9", // 9 = 時別値
    elementNumList: JSON.stringify([
      [ELEMENT_CODE_TEMPERATURE, ""],
      [ELEMENT_CODE_PRECIPITATION, ""],
    ]),
    interAnnualType: "1", // 1 = 連続期間
    ymdList: JSON.stringify([fy, ty, fm, tm, fd, td]),
    optionNumList: JSON.stringify([]),
    downloadFlag: "true",
    rmkFlag: "1",
    disconnectFlag: "1",
    youbiFlag: "0",
    fukenFlag: "0",
    kijiFlag: "0",
    huukouFlag: "0",
    csvFlag: "1",
    jikantaiFlag: "0",
    jikantaiList: JSON.stringify([1, 24]),
    ymdLiteral: "0", // "1"（日付リテラル）だと年月日時が1列に結合されてしまい、parseObsdlCsv()の列インデックス前提と合わなくなるため "0"（年,月,日,時に分割）を使う
  };

  const body = new URLSearchParams(payload).toString();

  const res = await fetch(OBSDL_SHOW, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": sessionCookie,
      "User-Agent": "Mozilla/5.0 (compatible; AppleScabApp/1.0)",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`obsdlへのリクエストに失敗しました (HTTP ${res.status})`);
  }

  const buffer = await res.arrayBuffer();
  // 気象庁のCSVはShift_JISで返ってくる
  return new TextDecoder("shift_jis").decode(buffer);
}

function parseObsdlCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);

  // 先頭の「ダウンロードした時刻」「空行」「見出し数行」をスキップし、
  // 年,月,日,時,... で始まるデータ行を探す
  const dataStartIndex = lines.findIndex((l) => /^\d{4},\d{1,2},\d{1,2},\d{1,2},/.test(l));
  if (dataStartIndex === -1) {
    // ヘッダ判定に失敗した場合は、デバッグ用に生データの先頭を返す
    throw new Error(
      "CSVのデータ行を検出できませんでした。先頭数行: " + lines.slice(0, 8).join(" | ")
    );
  }

  return lines.slice(dataStartIndex).map((line) => {
    const cols = line.split(",");
    // ⚠️ 列の並びは要検証（ファイル冒頭のコメント参照）
    // 想定: [年, 月, 日, 時, 気温, (品質情報等...), 降水量, (品質情報等...)]
    const [year, month, day, hour, temperature, , , precipitation] = cols;

    const dt = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9)); // JST->UTC変換
    return {
      datetime: dt.toISOString(),
      temperature_c: temperature === "" || temperature === undefined ? null : Number(temperature),
      precipitation_mm: precipitation === "" || precipitation === undefined ? null : Number(precipitation),
    };
  });
}
