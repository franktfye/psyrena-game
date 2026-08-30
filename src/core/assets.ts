import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";

// Side-effect imports. These register file-format handlers; without them the
// loader silently cannot read the format. Import ONLY what we actually ship —
// each one is bundle weight against the 30 MB initial-download budget.
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import "@babylonjs/loaders/glTF/2.0";

/**
 * The KTX2 transcoder binaries are vendored into `public/ktx2/` (668 KB) by
 * `npm run assets:ktx2`. Set this to false to fall back to the Babylon CDN.
 *
 * We self-host because the CDN puts a third-party request on the critical path
 * of a game whose entire onboarding pitch is "click a link and play" (doc 01).
 */
const SELF_HOST_KTX2 = true;

/**
 * Configure supercompressed textures.
 *
 * This is the highest-leverage single decision in the asset pipeline. KTX2 /
 * Basis Universal stays compressed *on the GPU* (transcoded to BC7 on desktop),
 * so it cuts both download size and resident memory.
 *
 * Contrast with Draco, which is frequently confused for a memory optimisation:
 * Draco compresses geometry for transport only and decompresses to full vertex
 * buffers in RAM. Adding Draco shrinks the .glb and does nothing for RSS.
 * Use both, for different reasons.
 */
export function configureTexturePipeline(): void {
  if (SELF_HOST_KTX2) {
    KhronosTextureContainer2.URLConfig = {
      jsDecoderModule: "/ktx2/babylon.ktx2Decoder.js",
      wasmUASTCToASTC: "/ktx2/uastc_astc.wasm",
      wasmUASTCToBC7: "/ktx2/uastc_bc7.wasm",
      wasmUASTCToRGBA_UNORM: "/ktx2/uastc_rgba8_unorm_v2.wasm",
      wasmUASTCToRGBA_SRGB: "/ktx2/uastc_rgba8_srgb_v2.wasm",
      wasmUASTCToR8_UNORM: "/ktx2/uastc_r8_unorm.wasm",
      wasmUASTCToRG8_UNORM: "/ktx2/uastc_rg8_unorm.wasm",
      jsMSCTranscoder: "/ktx2/msc_basis_transcoder.js",
      wasmMSCTranscoder: "/ktx2/msc_basis_transcoder.wasm",
      wasmZSTDDecoder: "/ktx2/zstddec.wasm",
    };
  }

  if (SELF_HOST_KTX2) {
    // The shipped glbs carry EXT_meshopt_compression (tools/meshopt-assets.mjs
    // packs them); Babylon's default decoder URL is the CDN — same critical-
    // path problem as the transcoders, so it rides along in public/ktx2/.
    MeshoptCompression.Configuration = {
      decoder: { url: "/ktx2/meshopt_decoder.js" },
    };
  }

  // Babylon defaults this to `true`, trading MEMORY for transcode SPEED: when
  // only BC1/BC3 are available it hands back uncompressed RGBA instead. That
  // default is exactly backwards for our budget — a 1024^2 map silently becomes
  // 5.6 MB instead of 1.4 MB. We would rather pay milliseconds at load than
  // carry 4x the texture memory for the whole session.
  KhronosTextureContainer2.DefaultDecoderOptions.useRGBAIfOnlyBC1BC3AvailableWhenUASTC = false;

  // One worker per core is wasteful on a 4-core dev box and on player laptops.
  KhronosTextureContainer2.DefaultNumWorkers = Math.min(
    4,
    Math.max(1, (navigator.hardwareConcurrency || 4) - 1)
  );
}

/** Approximate bytes-per-pixel for the compressed formats we actually ship. */
/**
 * Bytes per texel by GPU format.
 *
 * EVERY compressed format the KTX2 transcoder can emit must appear here. Any
 * format that is missing falls through to the `?? 4` default and is costed as
 * uncompressed RGBA — a 4x over-report on a BC7/ASTC texture.
 *
 * That is not a cosmetic inaccuracy. The HUD reads this to decide whether the
 * scene has breached `BUDGET.gpuMemoryMB`, so a missing entry invents a budget
 * breach out of nothing and sends someone optimising a problem they do not
 * have. `main.ts` already makes the point for the draw-call counter: a perf HUD
 * that lies is worse than no perf HUD.
 *
 * ASTC is the one that bit us — Basis/UASTC transcodes to ASTC 4x4 wherever the
 * device advertises it (which includes Chrome on plenty of desktops, not just
 * mobile), and its absence made a ~60 MB village report as 241 MB.
 */
const BPP: Record<number, number> = {
  // BPTC / BC7 — the desktop target. 16 bytes per 4x4 block = 1 byte/texel.
  [Constants.TEXTUREFORMAT_COMPRESSED_RGBA_BPTC_UNORM]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_BPTC_UNORM]: 1,

  // ASTC 4x4 — 128 bits per 4x4 block = 1 byte/texel.
  [Constants.TEXTUREFORMAT_COMPRESSED_RGBA_ASTC_4x4]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR]: 1,

  // S3TC / DXT. DXT1 is 8 bytes per 4x4 block, DXT3/5 are 16.
  [Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT5]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT3]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT1]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_RGB_S3TC_DXT1]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB_S3TC_DXT1_EXT]: 0.5,

  // ETC2 / ETC1 — the mobile fallback path.
  [Constants.TEXTUREFORMAT_COMPRESSED_RGBA8_ETC2_EAC]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ALPHA8_ETC2_EAC]: 1,
  [Constants.TEXTUREFORMAT_COMPRESSED_RGB8_ETC2]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ETC2]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2]: 0.5,
  [Constants.TEXTUREFORMAT_COMPRESSED_RGB_ETC1_WEBGL]: 0.5,
};

/**
 * Estimate resident texture memory.
 *
 * Deliberately an estimate: the browser does not expose true VRAM usage to the
 * page. Anything unrecognised is charged at 4 bytes/px (RGBA8), which is the
 * pessimistic case — an uncompressed texture that slipped past the pipeline is
 * precisely what we want this number to shout about.
 */
export function estimateTextureBytes(engine: AbstractEngine): { bytes: number; count: number } {
  const textures: InternalTexture[] = engine.getLoadedTexturesCache();
  let bytes = 0;

  for (const t of textures) {
    const bpp = BPP[t.format] ?? 4;
    let size = t.width * t.height * bpp;
    if (t.generateMipMaps) size *= 4 / 3; // full mip chain
    if (t.isCube) size *= 6;
    bytes += size;
  }

  return { bytes, count: textures.length };
}
