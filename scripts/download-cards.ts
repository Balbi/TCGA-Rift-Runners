import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://riftrunnerstcg.infinitecards.ca/_root.data";
const ACTION_URL = "https://riftrunnerstcg.infinitecards.ca/_root.data?index";
const OUTPUT_FILE = "RiftRunnersTCG_Cards.json";
const CARD_IMAGES_FOLDER = "cards";
const PUBLIC_CARD_IMAGE_BASE_URL = "https://balbi.github.io/TCGA-Rift-Runners/cards";
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
    back?: {
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
  tokens?: string[];
};

type TokenCard = {
  id?: string;
  isToken: true;
  [key: string]: unknown;
};

type CardFileEntry = RiftRunnersCard | TokenCard;

type CardsFile = Record<string, CardFileEntry>;

type GeneratedCards = {
  cardsFile: CardsFile;
  sets: string[];
  duplicateIds: string[];
  imageSourcesById: Map<string, string>;
};

type ImageDownload = {
  id: string;
  url: string;
  filename: string;
  outputPath: string;
};

type ImageDownloadPlan = {
  downloads: ImageDownload[];
  duplicateTargets: Array<{
    filename: string;
    keptId: string;
    skippedId: string;
  }>;
};

type ImageDownloadResult = {
  downloaded: number;
  skippedDuplicateTargets: number;
};

const KISKA_EXPECTED: RiftRunnersCard = {
  id: "#LR054MU1",
  isToken: false,
  face: {
    front: {
      name: "Kitten Frog Kiska",
      type: "Fighter",
      cost: 0,
      image: "https://balbi.github.io/TCGA-Rift-Runners/cards/LR054MU1.webp",
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
  const { cardsFile, sets, duplicateIds, imageSourcesById } = await generateCards();
  const outputPath = path.join(PROJECT_ROOT, OUTPUT_FILE);
  const existing = await readExistingCardsFile(outputPath);
  const preservedCards = getPreservedCards(existing, cardsFile);
  preserveExistingBackFaces(cardsFile, existing);
  const outputCards = { ...cardsFile, ...preservedCards };
  const imagePlan = createImageDownloadPlan(cardsFile, imageSourcesById);

  if (isDryRun) {
    await dryRun(outputCards, existing, sets, duplicateIds, imagePlan);
    return;
  }

  await writeFile(outputPath, `${JSON.stringify(outputCards, null, 2)}\n`, "utf8");
  const imageResult = await downloadCardImages(imagePlan);
  console.log(`Wrote ${Object.keys(outputCards).length} cards to ${OUTPUT_FILE} (${Object.keys(preservedCards).length} preserved local/token cards)`);
  console.log(`Downloaded ${imageResult.downloaded} card images to ${CARD_IMAGES_FOLDER}/ (${imageResult.skippedDuplicateTargets} duplicate target skipped)`);
}

async function generateCards(): Promise<GeneratedCards> {
  const databaseData = await fetchDatabaseData();
  const sets = getSetNames(databaseData);
  const sourceCards = await fetchCardsForSets(sets);
  const cardsFile: CardsFile = {};
  const duplicateIds: string[] = [];
  const imageSourcesById = new Map<string, string>();

  for (const sourceCard of sourceCards) {
    const card = mapCard(sourceCard);
    if (cardsFile[card.id]) {
      duplicateIds.push(card.id);
    }
    cardsFile[card.id] = card;
    imageSourcesById.set(card.id, image600Url(sourceCard.thumbnailUrl ?? sourceCard.imageUrl ?? sourceCard.image));
  }

  return { cardsFile, sets, duplicateIds, imageSourcesById };
}

async function dryRun(generated: CardsFile, existing: CardsFile, sets: string[], duplicateIds: string[], imagePlan: ImageDownloadPlan) {
  const generatedIds = Object.keys(generated);
  const existingIds = Object.keys(existing);
  const preservedCards = Object.fromEntries(Object.entries(generated).filter(([id]) => existing[id] && !imagePlan.downloads.some((download) => download.id === id)));
  const sharedIds = existingIds.filter((id) => generated[id]);
  const conflicts = sharedIds.flatMap((id) => compareCards(id, existing[id], generated[id]));
  const missingExistingIds = existingIds.filter((id) => !generated[id]);
  const newIds = generatedIds.filter((id) => !existing[id]);
  const generatedCardIds = generatedIds.filter((id) => isDownloadedCard(generated[id]));
  const badImages = generatedCardIds.filter((id) => {
    const card = generated[id];
    return isDownloadedCard(card) && card.face.front.image !== publicCardImageUrl(id);
  });
  const kiska = generated["#LR054MU1"] as RiftRunnersCard | undefined;
  const kiskaConflicts = compareCards("#LR054MU1", KISKA_EXPECTED, kiska);

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        wouldWrite: OUTPUT_FILE,
        sets,
        generatedCount: generatedCardIds.length,
        preservedTokenCount: Object.values(preservedCards).filter((card) => isTokenCard(card)).length,
        preservedLocalCardCount: Object.values(preservedCards).filter((card) => isLocalImageCard(card)).length,
        totalOutputCount: generatedIds.length,
        existingCount: existingIds.length,
        newCount: newIds.length,
        missingExistingCount: missingExistingIds.length,
        sharedCount: sharedIds.length,
        conflictCount: conflicts.length,
        duplicateGeneratedIds: duplicateIds,
        non600WebpImageCount: badImages.length,
        non600WebpImageIds: badImages.slice(0, 20),
        imageDownloads: {
          folder: CARD_IMAGES_FOLDER,
          wouldDownload: imagePlan.downloads.length,
          duplicateTargetCount: imagePlan.duplicateTargets.length,
          duplicateTargets: imagePlan.duplicateTargets.slice(0, 20)
        },
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

async function readExistingCardsFile(outputPath: string): Promise<CardsFile> {
  try {
    return JSON.parse(await readFile(outputPath, "utf8")) as CardsFile;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function getPreservedCards(cardsFile: CardsFile, generatedCards: CardsFile): CardsFile {
  return Object.fromEntries(
    Object.entries(cardsFile).filter(([id, card]) => isTokenCard(card) || isLocalImageCard(card) || !generatedCards[id])
  );
}

function preserveExistingBackFaces(cardsFile: CardsFile, existing: CardsFile) {
  for (const [id, card] of Object.entries(cardsFile)) {
    const existingCard = existing[id];
    if (!isDownloadedCard(card) || !existingCard || !isDownloadedCard(existingCard) || !existingCard.face.back) {
      continue;
    }

    card.face.back = existingCard.face.back;
  }
}

function createImageDownloadPlan(cardsFile: CardsFile, imageSourcesById: Map<string, string>): ImageDownloadPlan {
  const downloads: ImageDownload[] = [];
  const duplicateTargets: ImageDownloadPlan["duplicateTargets"] = [];
  const targets = new Map<string, string>();

  for (const [id, card] of Object.entries(cardsFile)) {
    if (!isDownloadedCard(card)) {
      continue;
    }

    const filename = `${imageFileStemFromCardId(id)}${imageExtension(card.face.front.image)}`;
    const outputPath = path.join(PROJECT_ROOT, CARD_IMAGES_FOLDER, filename);
    const keptId = targets.get(filename);

    if (keptId) {
      duplicateTargets.push({ filename, keptId, skippedId: id });
      continue;
    }

    targets.set(filename, id);
    downloads.push({
      id,
      url: imageSourcesById.get(id) ?? card.face.front.image,
      filename,
      outputPath
    });
  }

  return { downloads, duplicateTargets };
}

async function downloadCardImages(plan: ImageDownloadPlan): Promise<ImageDownloadResult> {
  await mkdir(path.join(PROJECT_ROOT, CARD_IMAGES_FOLDER), { recursive: true });

  const concurrency = 8;
  let downloaded = 0;

  for (let index = 0; index < plan.downloads.length; index += concurrency) {
    const batch = plan.downloads.slice(index, index + concurrency);
    await Promise.all(
      batch.map(async (download) => {
        const response = await fetch(download.url);
        if (!response.ok) {
          throw new Error(`Failed to download image for ${download.id}: ${response.status} ${response.statusText}`);
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(download.outputPath, bytes);
        downloaded += 1;
      })
    );
  }

  return {
    downloaded,
    skippedDuplicateTargets: plan.duplicateTargets.length
  };
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
        image: publicCardImageUrl(id),
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
    Tier: numberValue(card.tier ?? customAttributes.tier),
    ...(cardType === "Monarch" ? { tokens: ["XTOKEN"] } : {})
  };
}

function compareCards(id: string, expected: CardFileEntry | undefined, actual: CardFileEntry | undefined) {
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

function imageFileStemFromCardId(id: string): string {
  return id.replace(/^#/, "");
}

function publicCardImageUrl(id: string): string {
  return `${PUBLIC_CARD_IMAGE_BASE_URL}/${imageFileStemFromCardId(id)}.webp`;
}

function imageExtension(imageUrl: string): string {
  try {
    const extension = path.extname(new URL(imageUrl).pathname);
    return extension || ".webp";
  } catch {
    return ".webp";
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isDownloadedCard(card: CardFileEntry): card is RiftRunnersCard {
  return card.isToken === false;
}

function isTokenCard(card: CardFileEntry): card is TokenCard {
  return card.isToken === true;
}

function isLocalImageCard(card: CardFileEntry): card is RiftRunnersCard {
  return isDownloadedCard(card) && (card.Set === "Valkyries of Steel" || card.face.front.image.startsWith(`${CARD_IMAGES_FOLDER}/`));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
