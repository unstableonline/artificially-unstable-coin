import 'dotenv/config';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const {
  RPC_URL,
  PRIVATE_KEY_B58,
  TOKEN_MINT,
  QUOTE_MINT,
  SIDE,
  AMOUNT_IN_BASE_UNITS,
  MAX_SLIPPAGE_BPS,
  INTERVAL_SECONDS,
  DAILY_BUDGET_TRADES,
  DISCORD_WEBHOOK_URL,
} = process.env;

if (!RPC_URL || !PRIVATE_KEY_B58 || !TOKEN_MINT || !QUOTE_MINT || !SIDE) {
  console.error('Missing required env vars.');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
const TOKEN = new PublicKey(TOKEN_MINT);
const QUOTE = new PublicKey(QUOTE_MINT);
const INPUT  = SIDE === 'sell' ? TOKEN : QUOTE;
const OUTPUT = SIDE === 'sell' ? QUOTE : TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    });
  } catch {}
}

async function swapOnce() {
  const amount = Number(AMOUNT_IN_BASE_UNITS);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('AMOUNT_IN_BASE_UNITS must be a positive integer (base units).');
  }

  // 1) Get quote
  const q = new URL('https://quote-api.jup.ag/v6/quote');
  q.searchParams.set('inputMint', INPUT.toBase58());
  q.searchParams.set('outputMint', OUTPUT.toBase58());
  q.searchParams.set('amount', String(amount));
  q.searchParams.set('slippageBps', String(MAX_SLIPPAGE_BPS ?? 50));
  q.searchParams.set('onlyDirectRoutes', 'false');

  const quoteRes = await fetch(q.toString());
  if (!quoteRes.ok) throw new Error(`Quote error: ${quoteRes.statusText}`);
  const quoteJson = await quoteRes.json();
  const route = quoteJson?.data?.[0];
  if (!route) throw new Error('No route found (insufficient liquidity?)');

  // 2) Build swap tx
  const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: route,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap build error: ${swapRes.statusText}`);
  const { swapTransaction } = await swapRes.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

  // 3) Sign & send
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');

  return { sig, inMint: INPUT.toBase58(), outMint: OUTPUT.toBase58(), amount };
}

let tradesToday = 0;
let lastDay = new Date().getUTCDate();

async function loop() {
  while (true) {
    try {
      const now = new Date();
      const day = now.getUTCDate();
      if (day !== lastDay) { lastDay = day; tradesToday = 0; }

      if (tradesToday >= Number(DAILY_BUDGET_TRADES ?? 100)) {
        await discord('⏸ Daily trade limit reached. Waiting for next UTC day.');
      } else {
        const { sig, inMint, outMint, amount } = await swapOnce();
        tradesToday += 1;
        await discord(
          `✅ Executed ${SIDE.toUpperCase()} | inputMint=${inMint} → outputMint=${outMint}\n` +
          `• amount(base units)=${amount}\n` +
          `• tx: https://solscan.io/tx/${sig}`
        );
        console.log(`[${new Date().toISOString()}] Swap ok: ${sig}`);
      }
    } catch (e) {
      console.error(e);
      await discord(`⚠️ Swap error: ${e.message || e}`);
    }
    await sleep(Number(INTERVAL_SECONDS ?? 1200) * 1000);
  }
}

(async () => {
  const bal = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet ${wallet.publicKey.toBase58()} | SOL: ${(bal / LAMPORTS_PER_SOL).toFixed(4)}`);
  await discord(`🔁 Executor online for ${SIDE} | wallet \`${wallet.publicKey.toBase58()}\``);
  await loop();
})();
