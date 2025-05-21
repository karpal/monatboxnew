require("dotenv").config();
const ethers = require("ethers");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const {
  PRIVATE_KEY,
  PROVIDER_URL,
  CONTRACT_ADDRESS,
  FID,
  UPSTASH_AUTH,
  WARPCAST_TOKEN
} = process.env;

const CLAIM_INTERVAL = 3 * 60 * 60 * 1000; // 3 jam cooldown

if (!PRIVATE_KEY || !PROVIDER_URL || !FID || !UPSTASH_AUTH || !CONTRACT_ADDRESS || !WARPCAST_TOKEN) {
  console.error("❌ Harap isi semua variabel di file .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

async function getCooldown() {
  try {
    const res = await fetch(`https://monadbox.vercel.app/api/box-cooldown?fid=${FID}`);
    const data = await res.json();
    return data.lastOpen ?? null;
  } catch (err) {
    console.error("❌ Gagal ambil cooldown:", err);
    return null;
  }
}

async function claimBox() {
  const ABI = ["function openBox() external"];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  try {
    console.log("🚀 Mencoba klaim via on-chain (openBox)...");
    const tx = await contract.openBox();
    console.log(`⏳ Menunggu konfirmasi transaksi... Hash: ${tx.hash}`);
    await tx.wait();
    console.log("✅ Klaim on-chain berhasil!");
    return { ok: true, method: "on-chain", txHash: tx.hash };
  } catch (onChainError) {
    console.warn("⚠️ Klaim on-chain gagal. Mencoba fallback ke API...");
    console.warn(onChainError);

    try {
      const now = Date.now();
      const txPayload = {
        fid: Number(FID),
        timestamp: now,
      };

      const res = await fetch("https://monadbox.vercel.app/api/box-cooldown", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(txPayload),
      });

      const result = await res.json();

      if (result?.ok) {
        console.log("✅ Klaim via API berhasil (fallback).");
      } else {
        console.log("❌ Klaim API fallback gagal atau sudah pernah klaim.");
      }

      return { ok: result?.ok ?? false, method: "api" };
    } catch (apiError) {
      console.error("❌ Gagal klaim via API fallback:", apiError);
      return { ok: false, method: "none" };
    }
  }
}

async function getRankAndPoints() {
  try {
    const res = await fetch("https://evolved-macaw-13512.upstash.io/pipeline", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: UPSTASH_AUTH,
      },
      body: JSON.stringify([
        ["zscore", "leaderboard", Number(FID)],
        ["zrevrank", "leaderboard", Number(FID)],
      ]),
    });

    const data = await res.json();
    const points = data[0]?.result ?? "N/A";
    const rank = data[1]?.result != null ? data[1].result + 1 : "N/A";

    return { points, rank };
  } catch (err) {
    console.error("❌ Gagal ambil leaderboard:", err);
    return { points: "N/A", rank: "N/A" };
  }
}

async function getWarpcastUsername() {
  try {
    const res = await fetch("https://client.warpcast.com/v2/me", {
      method: "GET",
      headers: {
        "authorization": `Bearer ${WARPCAST_TOKEN}`,
        "accept": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ Warpcast API error: Status ${res.status}, Response: ${text}`);
      return "Unknown";
    }

    const data = await res.json();
    // console.log("Debug Warpcast user data:", data);  <-- hapus atau komentari ini

    return data?.result?.user?.username ?? "Unknown";
  } catch (err) {
    console.error("❌ Gagal ambil username Warpcast:", err);
    return "Unknown";
  }
}

async function sendWarpcastEvent() {
  try {
    const res = await fetch("https://client.warpcast.com/v2/frame-event", {
      method: "PUT",
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "authorization": `Bearer ${WARPCAST_TOKEN}`,
        "cache-control": "no-cache",
        "content-type": "application/json; charset=utf-8",
        "fc-amplitude-device-id": "JrBNb4rFA7aeWP-2LzABWL",
        "fc-amplitude-session-id": "1747823515418",
        "idempotency-key": `warpcast-${Date.now()}`,
        "pragma": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Chromium\";v=\"136\", \"Google Chrome\";v=\"136\", \"Not.A/Brand\";v=\"99\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site"
      },
      referrer: "https://warpcast.com/",
      referrerPolicy: "strict-origin-when-cross-origin",
      body: JSON.stringify({ event: { eventType: "frame-open", domain: "monadbox.vercel.app" } }),
      credentials: "include"
    });

    if (!res.ok) throw new Error(`Status ${res.status}`);

    console.log("✅ Warpcast event berhasil dikirim.");
    return true;
  } catch (error) {
    console.error("❌ Gagal kirim Warpcast event:", error);
    return false;
  }
}

function printCountdown(ms) {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(`⏳ Waktu cooldown tersisa: ${formatRemainingTime(ms)}`);
}

async function waitUntil(nextTimestamp) {
  while (true) {
    const now = Date.now();
    const remaining = nextTimestamp - now;
    if (remaining <= 0) break;
    printCountdown(remaining);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write("\n");
}

async function main() {
  console.log("🚀 Bot auto claim dimulai...\n");

  // Ambil username Warpcast sekali saja di awal
  const username = await getWarpcastUsername();

  while (true) {
    const lastOpen = await getCooldown();
    const now = Date.now();

    let nextClaim;
    if (!lastOpen) {
      console.log("⚠️ Tidak dapat data cooldown, coba claim langsung.");
      nextClaim = now; // langsung claim
    } else {
      nextClaim = lastOpen + CLAIM_INTERVAL;
    }

    if (now < nextClaim) {
      const { points, rank } = await getRankAndPoints();
      console.log(`👤 Warpcast: ${username} | 🎯 Rank: ${rank} | Points: ${points}`);
      await waitUntil(nextClaim);
    }

    const result = await claimBox();

    if (result?.ok) {
      console.log(`\n✅ Klaim berhasil via ${result.method}`);
      if (result.txHash) console.log(`🔗 Tx Hash: ${result.txHash}`);

      // Kirim event ke Warpcast supaya point bertambah
      await sendWarpcastEvent();
    } else {
      console.log("\n❌ Klaim gagal via semua metode.");
    }

    const { points, rank } = await getRankAndPoints();
    console.log(`👤 Warpcast: ${username} | 🎯 Rank: ${rank} | Points: ${points}\n`);

    // langsung cek cooldown baru tanpa delay tambahan
  }
}

main();
