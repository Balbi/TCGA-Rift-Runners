import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://riftrunnerstcg.infinitecards.ca/_root.data";
const ACTION_URL = "https://riftrunnerstcg.infinitecards.ca/_root.data?index";
const OUTPUT_FILE = "RiftRunnersTCG_Cards.json";
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

type EncodedValue =
  | EncodedScalar
  | EncodedArray
  | EncodedObject;

type EncodedScalar = null | string | number | boolean;

type EncodedArray = EncodedValue[];

type EncodedObject = {
  [key: string]: EncodedValue;
};

type SourceCard = {
  id?: number;
  serial?: string;
  number?: string;
  name?: string;
  set?: string;
  setName?: string;
  rarity?: string;
  rarityName?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  customAttributes?: Record<string, unknown>;
  formattedAttributes?: Record<string, unknown>;
  type?: string;
  card_type?: string;
  element?: string;
  class?: string;
  atk?: number | null;
  def?: number | null;
  unity_a?: number | null;
  unity_d?: number | null;
  tier?: number | null;
  effect?: string;
  card_text?: string;
  notes?: string;
  image?: string;
};

type RiftRunnersCard = {
  id: string;
  isToken: false;
  face: {
    front: {
      name: string;
      type: string;
      cost: 0;
      image: string;
      isHorizontal: false;
    };
  };
  name: string;
  type: string;
  cost: 0;
  Set: string;
  Element: string;
  Rarity: string;
  ATK: number;
  DEF: number;
  "Unity ATK": number;
  "Unity DEF": number;
  Tier: number;
};

type CardsFile = Record<string, RiftRunnersCard>;

type GeneratedCards = {
  cardsFile: CardsFile;
  sets: string[];
  duplicateIds: string[];
};

const KISKA_EXPECTED: RiftRunnersCard = {
  id: "#LR054MU1",
  isToken: false,
  face: {
    front: {
      name: "Kitten Frog Kiska",
      type: "Fighter",
      cost: 0,
      image: "https://cdn.buylist.ca/Single_Card_Images/watermarked/riftrunners/mystic-uprising/Kitten_Frog_Kiska_Mystic_Uprising_160__LR054MU1_600.webp",
      isHorizontal: false
    }
  },
  name: "Kitten Frog Kiska (Fighter)",
  type: "Fighter",
  cost: 0,
  Set: "Mystic Uprising",
  Element: "Thunder",
  Rarity: "Legendary Rare",
  ATK: 19,
  DEF: 24,
  "Unity ATK": 7,
  "Unity DEF": 7,
  Tier: 2
};

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const { cardsFile, sets, duplicateIds } = await generateCards();

  if (isDryRun) {
    await dryRun(cardsFile, sets, duplicateIds);
    return;
  }

  const outputPath = path.join(PROJECT_ROOT, OUTPUT_FILE);
  await writeFile(outputPath, `${JSON.stringify(cardsFile, null, 2)}\n`, "utf8");
  console.log(`Wrote ${Object.keys(cardsFile).length} cards to ${OUTPUT_FILE}`);
}

async function generateCards(): Promise<GeneratedCards> {
  const databaseData = await fetchDatabaseData();
  const sets = getSetNames(databaseData);
  const sourceCards = await fetchCardsForSets(sets);
  const cardsFile: CardsFile = {};
  const duplicateIds: string[] = [];

  for (const sourceCard of sourceCards) {
    const card = mapCard(sourceCard);
    if (cardsFile[card.id]) {
      duplicateIds.push(card.id);
    }
    cardsFile[card.id] = card;
  }

  return { cardsFile, sets, duplicateIds };
}

async function dryRun(generated: CardsFile, sets: string[], duplicateIds: string[]) {
  const outputPath = path.join(PROJECT_ROOT, OUTPUT_FILE);
  const existing = JSON.parse(await readFile(outputPath, "utf8")) as CardsFile;
  const generatedIds = Object.keys(generated);
  const existingIds = Object.keys(existing);
  const sharedIds = existingIds.filter((id) => generated[id]);
  const conflicts = sharedIds.flatMap((id) => compareCards(id, existing[id], generated[id]));
  const missingExistingIds = existingIds.filter((id) => !generated[id]);
  const newIds = generatedIds.filter((id) => !existing[id]);
  const badImages = generatedIds.filter((id) => !generated[id].face.front.image.endsWith("_600.webp"));
  const kiska = generated["#LR054MU1"];
  const kiskaConflicts = compareCards("#LR054MU1", KISKA_EXPECTED, kiska);

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        wouldWrite: OUTPUT_FILE,
        sets,
        generatedCount: generatedIds.length,
        existingCount: existingIds.length,
        newCount: newIds.length,
        missingExistingCount: missingExistingIds.length,
        sharedCount: sharedIds.length,
        conflictCount: conflicts.length,
        duplicateGeneratedIds: duplicateIds,
        non600WebpImageCount: badImages.length,
        non600WebpImageIds: badImages.slice(0, 20),
        missingExistingIds,
        conflicts: conflicts.slice(0, 20),
        kittenFrogKiska: {
          found: Boolean(kiska),
          matchesExpected: kiskaConflicts.length === 0,
          conflicts: kiskaConflicts,
          generated: kiska
        }
      },
      null,
      2
    )
  );
}

async function fetchDatabaseData(): Promise<Record<string, unknown>> {
  const decodedRoot = await fetchDecoded(SOURCE_URL);
  const routeData = asRecord(asRecord(decodedRoot)["routes/_index"]).data;
  return asRecord(asRecord(routeData).databaseData);
}

async function fetchCardsForSets(sets: string[]): Promise<SourceCard[]> {
  const body = new URLSearchParams();
  body.set("actionType", "getCards");
  body.set("requestKey", "download-cards");
  body.set("setNames", JSON.stringify(sets));

  const decodedAction = await fetchDecoded(ACTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body
  });

  const payload = asRecord(asRecord(decodedAction).data);
  if (payload.success !== true || payload.action !== "getCards") {
    throw new Error("Card database returned an unexpected getCards response");
  }

  const data = payload.data;
  if (!Array.isArray(data)) {
    throw new Error("Card database getCards response did not contain a card array");
  }

  return data.map((card) => asRecord(card) as SourceCard);
}

async function fetchDecoded(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Failed to download card data: ${response.status} ${response.statusText}`);
  }

  const encoded = (await response.json()) as EncodedValue[];
  return decodeIndex(encoded, 0);
}

function decodeIndex(encoded: EncodedValue[], index: number, seen = new Set<number>()): unknown {
  if (index === -5) {
    return null;
  }

  if (!Number.isInteger(index) || index < 0) {
    return index;
  }

  if (seen.has(index)) {
    throw new Error(`Circular reference while decoding _root.data at index ${index}`);
  }

  return decodeValue(encoded, encoded[index], new Set([...seen, index]));
}

function decodeValue(encoded: EncodedValue[], value: EncodedValue, seen: Set<number>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "number" ? decodeIndex(encoded, item, seen) : decodeValue(encoded, item, seen)));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const decodedKey = key.startsWith("_") ? String(decodeIndex(encoded, Number(key.slice(1)), seen)) : key;
        const decodedValue = typeof item === "number" ? decodeIndex(encoded, item, seen) : decodeValue(encoded, item, seen);
        return [decodedKey, decodedValue];
      })
    );
  }

  return value;
}

function getSetNames(databaseData: Record<string, unknown>): string[] {
  const setsData = databaseData.setsData;
  if (!Array.isArray(setsData) || !setsData.every((setName) => typeof setName === "string")) {
    throw new Error("Decoded _root.data did not contain databaseData.setsData");
  }

  return setsData;
}

function mapCard(card: SourceCard): RiftRunnersCard {
  const customAttributes = card.customAttributes ?? {};
  const id = normalizeCardNumber(card.serial ?? card.number ?? customAttributes.serial);
  const name = stringValue(card.name);
  const cardType = stringValue(card.card_type ?? card.type ?? customAttributes.type);

  return {
    id,
    isToken: false,
    face: {
      front: {
        name,
        type: cardType,
        cost: 0,
        image: image600Url(card.thumbnailUrl ?? card.imageUrl ?? card.image),
        isHorizontal: false
      }
    },
    name: `${name} (${cardType})`,
    type: cardType,
    cost: 0,
    Set: stringValue(card.setName ?? card.set),
    Element: normalizeElement(card.element ?? customAttributes.element),
    Rarity: stringValue(card.rarityName ?? card.rarity),
    ATK: numberValue(card.atk ?? customAttributes.atk),
    DEF: numberValue(card.def ?? customAttributes.def),
    "Unity ATK": numberValue(card.unity_a ?? customAttributes.unityA),
    "Unity DEF": numberValue(card.unity_d ?? customAttributes.unityD),
    Tier: numberValue(card.tier ?? customAttributes.tier)
  };
}

function compareCards(id: string, expected: RiftRunnersCard | undefined, actual: RiftRunnersCard | undefined) {
  if (!expected || !actual) {
    return [{ id, path: "", expected: expected ?? null, actual: actual ?? null }];
  }

  return compareValues(id, "", expected, actual);
}

function compareValues(id: string, pathName: string, expected: unknown, actual: unknown): Array<{ id: string; path: string; expected: unknown; actual: unknown }> {
  if (Object.is(expected, actual)) {
    return [];
  }

  if (!isPlainObject(expected) || !isPlainObject(actual)) {
    return [{ id, path: pathName, expected, actual }];
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].flatMap((key) => compareValues(id, pathName ? `${pathName}.${key}` : key, expected[key], actual[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object while decoding _root.data");
  }

  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCardNumber(value: unknown): string {
  const serial = stringValue(value).trim();
  return serial.startsWith("#") ? serial : `#${serial}`;
}

function normalizeElement(value: unknown): string {
  const element = stringValue(value);
  return element === "N/A" || element === "" ? "None" : element;
}

function image600Url(value: unknown): string {
  const imageUrl = stringValue(value);
  if (imageUrl.endsWith("_600.webp")) {
    return imageUrl;
  }

  if (imageUrl.endsWith(".webp")) {
    return `${imageUrl.slice(0, -".webp".length)}_600.webp`;
  }

  return imageUrl;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
