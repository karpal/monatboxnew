require("dotenv").config();
const ethers = require("ethers");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const {
  PRIVATE_KEY,
  PROVIDER_URL,
  CONTRACT_ADDRESS,
  FID,
  UPSTASH_AUTH
} = process.env;

const CLAIM_INTERVAL = 3 * 60 * 60 * 1000; // 3 jam
const POINTS_TO_ADD = 918;

if (!PRIVATE_KEY || !PROVIDER_URL || !FID || !UPSTASH_AUTH || !CONTRACT_ADDRESS) {
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

async function updatePoints(fid, points, method) {
  try {
    const res = await fetch("https://evolved-macaw-13512.upstash.io/pipeline", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: UPSTASH_AUTH,
      },
      body: JSON.stringify([
        ["zincrby", "leaderboard", points, String(fid)],
        ["lpush", `history:${fid}`, JSON.stringify({
          timestamp: Date.now(),
          method,
          points,
        })],
      ]),
    });
    const result = await res.json();
    return result;
  } catch (err) {
    console.error("❌ Gagal update poin ke Redis:", err);
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

    const redisUpdate = await updatePoints(FID, POINTS_TO_ADD, "on-chain");
    console.log("🎯 Poin berhasil ditambahkan ke leaderboard:", redisUpdate);

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

        const redisUpdate = await updatePoints(FID, POINTS_TO_ADD, "api-fallback");
        console.log("🎯 Poin berhasil ditambahkan ke leaderboard:", redisUpdate);
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
        ["zscore", "leaderboard", FID],
        ["zrevrank", "leaderboard", FID],
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

async function main() {
  console.log("🚀 Bot auto-claim dimulai...\n");

  while (true) {
    const lastOpen = await getCooldown();
    const now = Date.now();

    if (!lastOpen) {
      console.log("⚠️ Tidak dapat data cooldown, coba claim langsung.");
    } else {
      const nextClaim = lastOpen + CLAIM_INTERVAL;

      console.log(`🕐 Last open at: ${formatDate(lastOpen)}`);
      console.log(`🕐 Next claim at: ${formatDate(nextClaim)}`);

      if (now < nextClaim) {
        const remaining = nextClaim - now;
        console.log(`⏳ Waktu cooldown tersisa: ${formatRemainingTime(remaining)}`);

        const { points, rank } = await getRankAndPoints();
        console.log(`🎯 Rank: ${rank} | Points: ${points}\n`);

        await new Promise((r) => setTimeout(r, remaining));
        continue;
      }
    }

    const result = await claimBox();

    if (result?.ok) {
      console.log(`✅ Klaim berhasil via ${result.method}`);
      if (result.txHash) console.log(`🔗 Tx Hash: ${result.txHash}`);
    } else {
      console.log("❌ Klaim gagal via semua metode.");
    }

    const { points, rank } = await getRankAndPoints();
    console.log(`🎯 Rank: ${rank} | Points: ${points}\n`);

    await new Promise((r) => setTimeout(r, CLAIM_INTERVAL));
  }
}

main();
