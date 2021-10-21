import { ApiPromise, WsProvider } from "@polkadot/api";
import type { Option, u128, u32, Vec } from "@polkadot/types";
import type { PalletStakingForcing } from "@polkadot/types/lookup";
import type { BlockNumber, CandidateReceipt, Header, HeadData, Event, EventRecord } from "@polkadot/types/interfaces";

import * as PromClient from "prom-client";
import { config } from "dotenv";
import BN from "bn.js";
import * as http from "http";

config();

const WS_PROVIDER = process.env.WS_PROVIDER || "ws://localhost:9944";
const PORT = process.env.PORT || 8080;
const PARACHAIN_IDS = process.env.PARACHAIN_IDS ? JSON.parse(process.env.PARACHAIN_IDS) : [];

const INDEX_HTML = `
<!doctype html>
<html lang="en">
<head><title>polkadot-parachain-exporter</title></head>
<body>
    <ul>
        <li><a href="/metrics">/metrics</a></li>    
        <li><a href="/healthz">/healthz</a></li>    
    </ul>
</body>`;

const METRICS_PREFIX = process.env.METRICS_PREFIX || "ple";
const registry = new PromClient.Registry();

const relayBestBlock = new PromClient.Gauge({
  name: `${METRICS_PREFIX}_relaychain_best_block_number`,
  help: "best block of the relay chain"
});
registry.registerMetric(relayBestBlock);

const relayFinalizedHead = new PromClient.Gauge({
  name: `${METRICS_PREFIX}_relaychain_finalized_head_number`,
  help: "finalized head of the relay chain"
});
registry.registerMetric(relayFinalizedHead);

const relayActiveEraSlashesTotal = new PromClient.Gauge({
  name: `${METRICS_PREFIX}_relaychain_active_era_slashes_total`,
  help: "total amount of slashes in the active era"
});
registry.registerMetric(relayActiveEraSlashesTotal);

const paraBestBlock = new PromClient.Gauge({
  name: `${METRICS_PREFIX}_parachain_best_block_number`,
  help: "best block of a parachain",
  labelNames: ["para_id"],
});
registry.registerMetric(paraBestBlock);

const relayCurrentLeasePeriodIndex = new PromClient.Gauge({
  name: `${METRICS_PREFIX}_relaychain_current_lease_period_index`,
  help: "the current lease period index"
});
registry.registerMetric(relayCurrentLeasePeriodIndex);

const paraFinalLeasePeriod = new PromClient.Gauge({
  name: `${METRICS_PREFIX}_parachain_final_lease_period`,
  help: "set to 1 if a parachains lease will run out after the current lease period",
  labelNames: ["para_id"],
});
registry.registerMetric(paraFinalLeasePeriod);

function updateSlashes(events: Event[], tokenScale: BN) {
  if (!events.length) {
    return;
  }

  const blockTotal: BN = new BN(0);

  for (const event of events) {
    try {
      const amount = event.data[1] as u128;
      blockTotal.add(amount);
    } catch (err) {
      console.error(`failed to process slash event (${event.toJSON()}) skipping. error: ${err}`);
    }
  }

  const scaledBlockTotal: number = blockTotal.div(tokenScale).toNumber();
  relayActiveEraSlashesTotal.inc(scaledBlockTotal);
}

async function isNewEra(sessionChanges: Event[], api: ApiPromise): Promise<boolean> {
  if (!sessionChanges.length) {
    return false;
  }

  const currentEra: Option<u32> = await api.query.staking.currentEra();
  if (currentEra.isNone) {
    return false;
  }

  const erasStartSessionIndex: Option<u32> = await api.query.staking.erasStartSessionIndex(currentEra.unwrap());
  if (erasStartSessionIndex.isNone) {
    return false;
  }

  let newSessionIndex: u32;
  try {
    newSessionIndex = sessionChanges[0].data[0] as u32;
  } catch (err) {
    console.error(`failed to decode NewSession event: ${err}`);
    return false;
  }

  const forceEraMode: PalletStakingForcing = await api.query.staking.forceEra();
  return forceEraMode.isForceAlways || (erasStartSessionIndex.unwrap() === newSessionIndex);
}

async function checkNewEra(events: Event[], watchedParachainIds: number[], api: ApiPromise): Promise<void> {
  const eraChanged = await isNewEra(events, api);
  if (eraChanged) {
    relayActiveEraSlashesTotal.reset();
    await updateParachainLeases(watchedParachainIds, api);
  }
}

async function updateParachainLeases(watchedParachainIds: number[], api: ApiPromise): Promise<void> {
  const relayHead = await api.rpc.chain.getHeader();
  const relayHeight = new BN(relayHead.number.toNumber());
  const leasePeriod = api.consts.slots.leasePeriod as BlockNumber;
  const leasePeriodIndex = relayHeight.div(leasePeriod).toNumber();

  relayCurrentLeasePeriodIndex.set(leasePeriodIndex);

  await Promise.all(watchedParachainIds.map(async (paraId) => {
    const entries = await api.query.slots.leases.at<Vec<Option<any>>>(relayHead.hash, paraId);
    const leases = entries.filter(l => l.isSome);
    const finalLeasePeriodIndex =  leases.length ? leasePeriodIndex + (leases.length - 1) : 0;
    const metric = finalLeasePeriodIndex == leasePeriodIndex ? 1 : 0;

    paraFinalLeasePeriod.set({para_id: paraId}, metric);
  }));
}

async function updateParachainHeads(
  candidateInclusions: Event[],
  watchedParachainIds: number[],
  api: ApiPromise,
): Promise<void> {
  let calls: Promise<void>[] = [];

  for (const event of candidateInclusions) {
    let paraId: number;

    try {
      const c = event.data[0] as CandidateReceipt;
      paraId = c.descriptor.paraId.toNumber();
    } catch (_) {
      continue;
    }

    calls.push((async (pId) => {
      const maybeHeadData = await api.query.paras.heads<Option<HeadData>>(pId);
      if (maybeHeadData.isNone) {
        return;
      }

      const paraHeader: Header = api.createType("Header", maybeHeadData.unwrap().toHex());
      paraBestBlock.set({para_id: pId}, paraHeader.number.toNumber());
    })(paraId));
  }

  await Promise.all(calls);
}

async function handleEvents(
  events: Event[],
  tokenScale: BN,
  watchedParachainIds: number[],
  api: ApiPromise,
): Promise<void> {

  const slashes = events.filter(api.events.staking.Slashed.is);
  updateSlashes(slashes, tokenScale);

  const sessionChanges = events.filter(api.events.session.NewSession.is);

  // include CurrentHeadUpdated?
  const candidateInclusions = events.filter(e => e.section === "paraInclusion" && e.method === "CandidateIncluded");

  await Promise.all([
    checkNewEra(sessionChanges, watchedParachainIds, api),
    updateParachainHeads(candidateInclusions, watchedParachainIds, api),
  ]);
}

interface AppHealth {
  error: boolean
}

async function connectRPC(wsURL: string, health: AppHealth, watchedParachainIds: number[]): Promise<ApiPromise> {
  const api = new ApiPromise({provider: new WsProvider(wsURL)});

  api.on("connected", () => health.error = false);
  api.on("error", () => health.error = true);

  api.on("ready", async () => {
    const chain = await api.rpc.system.chain();
    registry.setDefaultLabels({
      chain: chain.toLowerCase(),
    });

    await Promise.all([
      setupSubscriptions(watchedParachainIds, api),
      updateParachainLeases(watchedParachainIds, api),
    ]);
  });

  return api;
}

async function setupSubscriptions(watchedParachainIds: number[], api: ApiPromise): Promise<void> {
  const chainDecimals: number = api.registry.chainDecimals[0];
  const tokenScale = new BN(Math.pow(10, chainDecimals));

  relayActiveEraSlashesTotal.set(0);

  await Promise.all([
    api.derive.chain.subscribeNewHeads((header: Header) => {
      relayBestBlock.set(header.number.toNumber());
    }),

    api.rpc.chain.subscribeFinalizedHeads((header: Header) => {
      relayFinalizedHead.set(header.number.toNumber());
    }),

    api.query.system.events(async (records: Vec<EventRecord>): Promise<void> => {
      const events: Event[] = records.map(record => record.event);
      await handleEvents(events, tokenScale, watchedParachainIds, api);
    }),
  ]);
}

function createServer(indexHTML: string, health: AppHealth): http.Server {
  return http.createServer(async (req, res) => {

    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());

    } else if (req.url === "/healthz") {
      res.setHeader("Content-Type", "text/plain");
      res.statusCode = health.error ? 500 : 200;
      res.end(health.error ? "API ERROR" : "OK");

    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(indexHTML);
    }
  });
}

async function main() {
  const health: AppHealth = { error: false };
  const api = await connectRPC(WS_PROVIDER, health, PARACHAIN_IDS);
  const server = createServer(INDEX_HTML, health);

  await api.isReadyOrError;

  server.listen(PORT);
  server.on("listening", () => console.log(`Server listening on port ${PORT}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
