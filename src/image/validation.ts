import { isIP } from "node:net";
import { assert, CodexError, record } from "../core/errors.js";
import type { ModelInfo } from "../core/types.js";
export function strictBase64(value: unknown, max: number): Buffer {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= Math.ceil(max / 3) * 4 &&
      value.length % 4 === 0 &&
      !/[^A-Za-z0-9+/=]/.test(value),
    "Image data must be nonempty strict base64 within the byte limit.",
  );
  const padding = value.indexOf("=");
  assert(
    padding === -1 ||
      padding === value.length - 1 ||
      (padding === value.length - 2 && value.endsWith("==")),
    "Image base64 padding is invalid.",
  );
  const padCount = padding === -1 ? 0 : value.length - padding;
  // RFC 4648 canonical pad bits: one '=' leaves two zero bits, two leave four.
  const tail = padCount
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
        value[padding - 1]!,
      )
    : 0;
  const decodedSize = (value.length / 4) * 3 - padCount;
  assert(
    decodedSize > 0 &&
      decodedSize <= max &&
      (padCount === 0 || (tail & (padCount === 2 ? 15 : 3)) === 0),
    "Image base64 data or decoded size is invalid.",
  );
  const bytes = Buffer.from(value, "base64");
  assert(
    bytes.length === decodedSize,
    "Image base64 data or decoded size is invalid.",
  );
  return bytes;
}
export function imageMime(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  const b = Buffer.from(bytes.subarray(0, 12));
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6)))
    return "image/gif";
  throw new CodexError(
    "configuration",
    "Image bytes do not contain a supported raster signature.",
  );
}
function httpsImage(value: string) {
  assert(
    !/[\x00-\x20\x7f]/.test(value),
    "Image URL contains invalid characters.",
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexError("configuration", "Image URL is invalid.");
  }
  assert(
    url.protocol === "https:" && !url.username && !url.password,
    "Use an HTTPS image URL without credentials.",
  );
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  assert(
    host !== "localhost" &&
      !host.endsWith(".localhost") &&
      host !== "metadata.google.internal",
    "Local or metadata image URLs are unsupported.",
  );
  if (isIP(host)) {
    const private4 =
      /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(18|19)\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/;
    assert(
      (!private4.test(host) && !host.includes(":")) ||
        (host.includes(":") &&
          !/^(::|::1$|f[cd]|fe[89ab]|ff|::ffff:)/i.test(host)),
      "Private, link-local or metadata IP image URLs are unsupported.",
    );
  }
}
export interface ImageBudget {
  count: number;
  bytes: number;
}
export function normalizeImage(
  block: Record<string, unknown>,
  model: ModelInfo,
  budget: ImageBudget,
): Record<string, unknown> {
  assert(model.supportsImages, "Image input is not advertised for this model.");
  let source: Record<string, unknown>, url: unknown, detail: unknown;
  if (block.type === "image_url") {
    assert(
      Object.keys(block).every((k) => ["type", "image_url"].includes(k)),
      "Image input contains unsupported fields.",
    );
    source =
      typeof block.image_url === "string"
        ? { url: block.image_url }
        : record(block.image_url);
    assert(
      Object.keys(source).every((k) => ["url", "detail"].includes(k)),
      "Image URL contains unsupported fields.",
    );
    url = source.url;
    detail = source.detail;
  } else if (block.type === "input_image") {
    assert(
      Object.keys(block).every((k) =>
        ["type", "image_url", "detail"].includes(k),
      ),
      "Image input contains unsupported fields.",
    );
    url = block.image_url;
    detail = block.detail;
  } else {
    assert(block.type === "image", "This content block is not an image.");
    assert(
      Object.keys(block).every((k) =>
        [
          "type",
          "source_type",
          "url",
          "mime_type",
          "mimeType",
          "data",
          "detail",
          "id",
          "index",
        ].includes(k),
      ),
      "Image content contains unsupported fields.",
    );
    const hasUrl = block.url !== undefined,
      hasData = block.data !== undefined;
    assert(
      hasUrl !== hasData,
      "Image content must have exactly one URL or base64 source.",
    );
    assert(
      block.source_type === undefined ||
        block.source_type === (hasUrl ? "url" : "base64"),
      "Image source type does not match its content.",
    );
    if (hasUrl) url = block.url;
    else {
      assert(
        block.mime_type === undefined ||
          block.mimeType === undefined ||
          block.mime_type === block.mimeType,
        "Image MIME declarations conflict.",
      );
      const mime = block.mime_type ?? block.mimeType;
      assert(
        typeof mime === "string",
        "Image MIME type is required for base64 data.",
      );
      const data =
        block.data instanceof Uint8Array
          ? Buffer.from(block.data).toString("base64")
          : block.data;
      assert(
        typeof data === "string",
        "Image data must be base64 or Uint8Array.",
      );
      url = `data:${mime};base64,${data}`;
    }
    detail = block.detail;
  }
  assert(
    typeof url === "string" && url.length <= 30 * 1024 * 1024,
    "Image URL or data exceeds its limit.",
  );
  assert(
    detail === undefined ||
      (typeof detail === "string" &&
        (["auto", "low", "high"].includes(detail) ||
          (detail === "original" && model.originalImageDetail === true))),
    "Image detail is unsupported or not advertised.",
  );
  if (url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/.exec(url);
    assert(match, "Use a supported raster MIME type and strict base64.");
    const bytes = strictBase64(match[2], 10 * 1024 * 1024);
    assert(
      imageMime(bytes) === match[1],
      "Image bytes do not match the declared MIME type.",
    );
    budget.bytes += bytes.length;
    assert(
      budget.bytes <= 20 * 1024 * 1024,
      "Images exceed the aggregate decoded byte limit.",
    );
  } else httpsImage(url);
  assert(++budget.count <= 10, "A model call accepts at most ten images.");
  return { type: "input_image", image_url: url, detail: detail ?? "auto" };
}
export function imageDimensions(bytes: Buffer): {
  mimeType: ReturnType<typeof imageMime>;
  extension: string;
  width: number;
  height: number;
} {
  const mimeType = imageMime(bytes);
  let width = 0,
    height = 0;
  const size = bytes.length;
  if (mimeType === "image/png") {
    assert(
      size >= 33 &&
        bytes.readUInt32BE(8) === 13 &&
        bytes.toString("latin1", 12, 16) === "IHDR",
      "PNG header is truncated or invalid.",
    );
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mimeType === "image/gif") {
    assert(size >= 13, "GIF header is truncated.");
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (mimeType === "image/jpeg") {
    let offset = 2,
      markers = 0;
    while (offset < size && offset < 256 * 1024 && ++markers <= 1024) {
      assert(bytes[offset] === 255, "JPEG marker is invalid.");
      while (offset < Math.min(size, 256 * 1024) && bytes[offset] === 255)
        offset++;
      assert(offset < 256 * 1024, "JPEG header exceeds the scan limit.");
      const marker = bytes[offset++];
      assert(marker !== undefined, "JPEG header is truncated.");
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      assert(offset + 2 <= size, "JPEG header is truncated.");
      const length = bytes.readUInt16BE(offset);
      assert(
        length >= 2 && offset + length <= size,
        "JPEG segment is truncated or invalid.",
      );
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        assert(length >= 8, "JPEG dimension header is invalid.");
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else {
    assert(
      size >= 20 && bytes.readUInt32LE(4) + 8 === size,
      "WebP container length is invalid.",
    );
    const kind = bytes.toString("latin1", 12, 16),
      chunk = bytes.readUInt32LE(16);
    assert(chunk <= size - 20, "WebP chunk is truncated.");
    if (kind === "VP8X") {
      assert(chunk >= 10 && size >= 30, "WebP VP8X header is truncated.");
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8 ") {
      assert(
        chunk >= 10 &&
          size >= 30 &&
          bytes[23] === 0x9d &&
          bytes[24] === 0x01 &&
          bytes[25] === 0x2a,
        "WebP VP8 header is invalid.",
      );
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L") {
      assert(
        chunk >= 5 && size >= 25 && bytes[20] === 0x2f,
        "WebP VP8L header is invalid.",
      );
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else
      throw new CodexError("protocol", "Unsupported WebP dimension header.");
  }
  assert(
    width > 0 &&
      height > 0 &&
      width <= 16384 &&
      height <= 16384 &&
      width * height <= 64000000,
    "Image dimensions are missing, invalid or exceed the safety limit.",
  );
  return {
    mimeType,
    extension: {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    }[mimeType],
    width,
    height,
  };
}
