import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  Upload, Plus, Trash2, Music, ListMusic, Volume2, VolumeX, X,
  Disc3, Search, SlidersHorizontal, Moon, GripVertical, ChevronDown,
  Home, Library as LibraryIcon, MoreHorizontal, ListPlus, CornerDownRight,
  Info, Mic2, ArrowLeft, LayoutGrid, List as ListIcon, ArrowUpDown,
  Clock, TrendingUp, Heart, CheckCircle2, Circle, PictureInPicture2,
  Share2, FolderPlus, Tag, HardDrive, Download, Upload as UploadIcon,
  Settings, Sparkles, Waves, Wind, Gauge
} from "lucide-react";

// =====================================================================
// helpers
// =====================================================================
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};
const uid = () => Math.random().toString(36).slice(2, 10);

const artHue = (name = "") => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 360;
};
const artGradient = (name) => {
  const h1 = artHue(name), h2 = (h1 + 46) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 42%), hsl(${h2} 75% 24%))`;
};

let decodeCtx = null;
const getDecodeCtx = () => {
  if (!decodeCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new AC();
  }
  return decodeCtx;
};

async function computePeaks(file, samples = 160) {
  try {
    const buf = await file.arrayBuffer();
    const ctx = getDecodeCtx();
    const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
    const channel = audioBuffer.getChannelData(0);
    const blockSize = Math.floor(channel.length / samples) || 1;
    const peaks = new Array(samples).fill(0);
    for (let i = 0; i < samples; i++) {
      let max = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j++) {
        const v = Math.abs(channel[start + j] || 0);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    const peakMax = Math.max(...peaks, 0.01);
    const normPeaks = peaks.map((p) => p / peakMax);

    // WOW — auto silence-trim: detect near-silent lead-in/lead-out so
    // playback can skip dead air at the start of a track automatically.
    const SILENCE_THRESH = 0.04;
    let leadIdx = 0;
    while (leadIdx < normPeaks.length && normPeaks[leadIdx] < SILENCE_THRESH) leadIdx++;
    let tailIdx = normPeaks.length - 1;
    while (tailIdx > 0 && normPeaks[tailIdx] < SILENCE_THRESH) tailIdx--;
    const secondsPerSample = audioBuffer.duration / samples;
    const trimStart = leadIdx > 1 ? +(leadIdx * secondsPerSample).toFixed(2) : 0;
    const trimEnd = tailIdx < normPeaks.length - 2 ? +((normPeaks.length - 1 - tailIdx) * secondsPerSample).toFixed(2) : 0;

    return { peaks: normPeaks, duration: audioBuffer.duration, trimStart, trimEnd };
  } catch {
    return { peaks: null, duration: 0, trimStart: 0, trimEnd: 0 };
  }
}

// ---- embedded album art extraction (ID3v2 APIC for MP3, PICTURE block for FLAC) ----
async function extractIdMp3Art(file) {
  try {
    const head = await file.slice(0, 10).arrayBuffer();
    const h = new Uint8Array(head);
    if (!(h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33)) return null;
    const size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
    const tagBuf = await file.slice(10, 10 + size).arrayBuffer();
    const bytes = new Uint8Array(tagBuf);
    let offset = 0;
    while (offset < bytes.length - 10) {
      const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const frameSize = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      if (!frameId.trim() || frameSize <= 0 || offset + 10 + frameSize > bytes.length) break;
      if (frameId === "APIC") {
        let p = offset + 10;
        const enc = bytes[p]; p += 1;
        let mimeEnd = p;
        while (bytes[mimeEnd] !== 0 && mimeEnd < offset + 10 + frameSize) mimeEnd++;
        const mime = new TextDecoder("ascii").decode(bytes.slice(p, mimeEnd));
        p = mimeEnd + 1;
        p += 1;
        if (enc === 1 || enc === 2) {
          while (!(bytes[p] === 0 && bytes[p + 1] === 0) && p < offset + 10 + frameSize) p += 2;
          p += 2;
        } else {
          while (bytes[p] !== 0 && p < offset + 10 + frameSize) p++;
          p += 1;
        }
        const picData = bytes.slice(p, offset + 10 + frameSize);
        if (picData.length > 100) return new Blob([picData], { type: mime || "image/jpeg" });
      }
      offset += 10 + frameSize;
    }
    return null;
  } catch { return null; }
}
async function extractFlacArt(file) {
  try {
    const sigBuf = await file.slice(0, 4).arrayBuffer();
    const sig = new Uint8Array(sigBuf);
    if (!(sig[0] === 0x66 && sig[1] === 0x4c && sig[2] === 0x61 && sig[3] === 0x43)) return null;
    let pos = 4;
    for (let guard = 0; guard < 64; guard++) {
      const hdrBuf = await file.slice(pos, pos + 4).arrayBuffer();
      const hdr = new Uint8Array(hdrBuf);
      if (hdr.length < 4) break;
      const last = (hdr[0] & 0x80) !== 0;
      const blockType = hdr[0] & 0x7f;
      const blockLen = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
      if (blockType === 6) {
        const blockBuf = await file.slice(pos + 4, pos + 4 + blockLen).arrayBuffer();
        const b = new Uint8Array(blockBuf);
        const dv = new DataView(blockBuf);
        let p = 4;
        const mimeLen = dv.getUint32(p); p += 4;
        const mime = new TextDecoder("ascii").decode(b.slice(p, p + mimeLen)); p += mimeLen;
        const descLen = dv.getUint32(p); p += 4;
        p += descLen + 16;
        const dataLen = dv.getUint32(p); p += 4;
        const picData = b.slice(p, p + dataLen);
        if (picData.length > 100) return new Blob([picData], { type: mime || "image/jpeg" });
        return null;
      }
      pos += 4 + blockLen;
      if (last) break;
    }
    return null;
  } catch { return null; }
}
async function extractEmbeddedArt(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "mp3") return extractIdMp3Art(file);
  if (ext === "flac") return extractFlacArt(file);
  return null;
}

// WOW — dominant color sampled from the real album art, used to theme Now Playing
function extractDominantColor(url) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 16; canvas.height = 16;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, 16, 16);
          const data = ctx.getImageData(0, 0, 16, 16).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
          resolve({ r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch { resolve(null); }
  });
}

// ---- IndexedDB persistence ----
const DB_NAME = "spool-db", DB_VERSION = 1;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPutTrack(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").put(record);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function idbGetTrack(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readonly");
    const req = tx.objectStore("tracks").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbDeleteTrack(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function idbGetAllTracks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readonly");
    const req = tx.objectStore("tracks").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbSetMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key, value });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function idbGetMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";
const THEMES = {
  amoled: { bg: "#000000", surface: "#1C1C1E", surface2: "#2C2C2E", text: "#FFFFFF", subtext: "#98989D", accent: "#FA2D48" },
  colorful: { bg: "#12071F", surface: "#1F1235", surface2: "#2C1A47", text: "#FFFFFF", subtext: "#B6A6D6", accent: "#B84DFF" },
  light: { bg: "#F5F5F7", surface: "#FFFFFF", surface2: "#ECECEE", text: "#111111", subtext: "#6E6E73", accent: "#FA2D48" },
};
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
const MOOD_TAGS = ["Chill", "Workout", "Study", "Party", "Focus"];

const VINYL_COLORS = {
  classic: { name: "Classic", base: "#1a1a1a", groove: "#262626", swatch: "#1a1a1a" },
  ruby: { name: "Ruby", base: "#3a0d14", groove: "#5c1420", swatch: "#8f1d2c" },
  ocean: { name: "Ocean", base: "#0d1f38", groove: "#16324f", swatch: "#1f6fb2" },
  forest: { name: "Forest", base: "#132a17", groove: "#1e3f24", swatch: "#2f8f45" },
  amber: { name: "Amber", base: "#3a2408", groove: "#57350c", swatch: "#c98a1c" },
  frost: { name: "Frost", base: "#2c2f33", groove: "#3d4147", swatch: "#c9ccd1" },
  gold: { name: "Gold", base: "#2e2306", groove: "#4a3708", swatch: "#e0ac2b" },
  marble: { name: "Marble", base: "#28282c", groove: "#c9c9d1", swatch: "#a8a8b3" },
  neon: { name: "Neon", base: "#160321", groove: "#3d0a5c", swatch: "#c026ff" },
  sunburst: { name: "Sunburst", base: "#3a1006", groove: "#7a2c0a", swatch: "#ff7a1a" },
};
const VINYL_BACKDROPS = {
  studio: { name: "Studio", css: "radial-gradient(circle, #2a2a2a 0%, #0a0a0a 70%)" },
  warm: { name: "Warm", css: "radial-gradient(circle, #4a2f1c 0%, #140a04 75%)" },
  cool: { name: "Cool", css: "radial-gradient(circle, #1c2f4a 0%, #04070f 75%)" },
  sunset: { name: "Sunset", css: "radial-gradient(circle, #4a1c3a 0%, #150512 75%)" },
  mint: { name: "Mint", css: "radial-gradient(circle, #1c4a35 0%, #04150e 75%)" },
  velvet: { name: "Velvet", css: "radial-gradient(circle, #350f2e 0%, #0c0209 75%)" },
  wood: { name: "Wood", css: "radial-gradient(circle, #4a3420 0%, #170e06 75%)" },
  brick: { name: "Brick", css: "radial-gradient(circle, #4a2016 0%, #150705 75%)" },
  noir: { name: "Noir", css: "radial-gradient(circle, #202225 0%, #000000 78%)" },
};
const RPM_SPEEDS = { 33: 3.5, 45: 2.6 };

const EQ_PRESETS = {
  Flat: { bass: 0, mid: 0, treble: 0 },
  "Bass Boost": { bass: 7, mid: 1, treble: 0 },
  Vocal: { bass: -2, mid: 5, treble: 2 },
  Rock: { bass: 4, mid: -2, treble: 4 },
};

// =====================================================================
export default function MusicPlayer() {
  const [loaded, setLoaded] = useState(false);
  const [library, setLibrary] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [lyricsMap, setLyricsMap] = useState({});
  const [playCounts, setPlayCounts] = useState({});
  const [recentlyPlayed, setRecentlyPlayed] = useState([]);
  const [positions, setPositions] = useState({});
  const [likedIds, setLikedIds] = useState([]);

  const [activeTab, setActiveTab] = useState("home");
  const [openPlaylistId, setOpenPlaylistId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [librarySort, setLibrarySort] = useState("recent");
  const [libraryView, setLibraryView] = useState("list");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkAddSheetOpen, setBulkAddSheetOpen] = useState(false);

  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueSource, setQueueSource] = useState("");

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState("off");
  const [themeColor, setThemeColor] = useState(null);

  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [npView, setNpView] = useState("player");
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [artSwipeX, setArtSwipeX] = useState(0);
  const [showEq, setShowEq] = useState(false);
  const [eqBands, setEqBands] = useState({ bass: 0, mid: 0, treble: 0 });
  const [eqPreset, setEqPreset] = useState("Flat");
  const [showSleep, setShowSleep] = useState(false);
  const [sleepEndsAt, setSleepEndsAt] = useState(null);
  const [sleepRemaining, setSleepRemaining] = useState(null);

  const [addSheetTrackId, setAddSheetTrackId] = useState(null);
  const [contextTrackId, setContextTrackId] = useState(null);
  const [contextInfo, setContextInfo] = useState(null);
  const [infoSheetTrackId, setInfoSheetTrackId] = useState(null);
  const [newPlaylistSheet, setNewPlaylistSheet] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [renameTrackId, setRenameTrackId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [toast, setToast] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [rowDragIdx, setRowDragIdx] = useState(null);

  // ---- new feature state ----
  const [theme, setTheme] = useState("amoled"); // amoled | colorful | light
  const [showSettings, setShowSettings] = useState(false);
  const [normalizeVolume, setNormalizeVolume] = useState(false);
  const [smartContinueEnabled, setSmartContinueEnabled] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const [crossfadeSec, setCrossfadeSec] = useState(3);
  const [showCrossfadeMenu, setShowCrossfadeMenu] = useState(false);
  const [vinylMode, setVinylMode] = useState(false);
  const [vinylColor, setVinylColor] = useState("classic");
  const [vinylBackdrop, setVinylBackdrop] = useState("studio");
  const [crackleEnabled, setCrackleEnabled] = useState(false);
  const [armDragging, setArmDragging] = useState(false);
  const [armAngleOverride, setArmAngleOverride] = useState(null);
  // Vinyl Mode 2.0 — RPM, ambience & interaction upgrades
  const [vinylRPM, setVinylRPM] = useState(33);
  const [vinylShine, setVinylShine] = useState(true);
  const [vinylDust, setVinylDust] = useState(true);
  const [vinylReactive, setVinylReactive] = useState(true);
  const [showVinylPanel, setShowVinylPanel] = useState(false);
  const [scratchDragging, setScratchDragging] = useState(false);
  const [scratchAngle, setScratchAngle] = useState(0);
  const [loopA, setLoopA] = useState(null);
  const [loopB, setLoopB] = useState(null);
  const [newPlaylistFromQueue, setNewPlaylistFromQueue] = useState(false);
  const [tagsMap, setTagsMap] = useState({});
  const [activeTagFilter, setActiveTagFilter] = useState(null);
  const [tagSheetTrackId, setTagSheetTrackId] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [celebratedMilestones, setCelebratedMilestones] = useState([]);
  const [confettiMilestone, setConfettiMilestone] = useState(null);
  const [storageEstimate, setStorageEstimate] = useState(null);
  const backupInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const pipCanvasRef = useRef(null);
  const pipVideoRef = useRef(null);

  const audioARef = useRef(null);
  const audioBRef = useRef(null);
  const gainARef = useRef(null);
  const gainBRef = useRef(null);
  const activeDeckRef = useRef("A");
  const crossfadingRef = useRef(false);
  const urlARef = useRef(null);
  const urlBRef = useRef(null);

  const fileInputRef = useRef(null);
  const vuCanvasRef = useRef(null);
  const waveCanvasRef = useRef(null);
  const waveWrapRef = useRef(null);
  const bgGlowRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const masterGainRef = useRef(null);
  const normGainRef = useRef(null);
  const crackleGainRef = useRef(null);
  const crackleSourceRef = useRef(null);
  const crackleBufferRef = useRef(null);
  const normLevelRef = useRef(0.5);
  const normalizeVolumeRef = useRef(false);
  const crossfadeSecRef = useRef(3);
  const eqRefs = useRef({});
  const rafRef = useRef(null);
  const sleepTimeoutRef = useRef(null);
  const sleepFadeTimeoutRef = useRef(null);
  const touchStartY = useRef(0);
  const artTouchStartX = useRef(0);
  const armDragRef = useRef(null);
  const vinylPulseRef = useRef(null);
  const scratchRef = useRef(null);
  const toastTimer = useRef(null);
  const resumeSeekRef = useRef(null);
  const lastSaveRef = useRef(0);

  const currentTrack = library.find((t) => t.id === queue[queueIndex]) || null;
  const activePlaylist = playlists.find((p) => p.id === openPlaylistId) || null;
  const deckAudio = (d) => (d === "A" ? audioARef.current : audioBRef.current);
  const deckGain = (d) => (d === "A" ? gainARef.current : gainBRef.current);
  const deckUrlRef = (d) => (d === "A" ? urlARef : urlBRef);
  const otherDeck = (d) => (d === "A" ? "B" : "A");

  const showToast = (msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 1800); };

  // ------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const tracks = await idbGetAllTracks();
        setLibrary(tracks.map((r) => ({
          id: r.id, name: r.name, ext: r.ext, duration: r.duration, peaks: r.peaks,
          addedAt: r.addedAt, file: r.blob, artUrl: r.artBlob ? URL.createObjectURL(r.artBlob) : null,
          trimStart: r.trimStart || 0, trimEnd: r.trimEnd || 0,
        })));
        const pl = await idbGetMeta("playlists"); if (pl) setPlaylists(pl);
        const ly = await idbGetMeta("lyrics"); if (ly) setLyricsMap(ly);
        const pc = await idbGetMeta("playCounts"); if (pc) setPlayCounts(pc);
        const rp = await idbGetMeta("recentlyPlayed");
        if (rp) setRecentlyPlayed(rp.length && typeof rp[0] === "string" ? rp.map((id) => ({ id, ts: Date.now() })) : rp);
        const tg = await idbGetMeta("tags"); if (tg) setTagsMap(tg);
        const cm = await idbGetMeta("celebratedMilestones"); if (cm) setCelebratedMilestones(cm);
        const th = await idbGetMeta("theme"); if (th) setTheme(th);
        const vc = await idbGetMeta("vinylColor"); if (vc) setVinylColor(vc);
        const vb = await idbGetMeta("vinylBackdrop"); if (vb) setVinylBackdrop(vb);
        const ce = await idbGetMeta("crackleEnabled"); if (ce != null) setCrackleEnabled(ce);
        const vr = await idbGetMeta("vinylRPM"); if (vr) setVinylRPM(vr);
        const vsh = await idbGetMeta("vinylShine"); if (vsh != null) setVinylShine(vsh);
        const vd = await idbGetMeta("vinylDust"); if (vd != null) setVinylDust(vd);
        const vre = await idbGetMeta("vinylReactive"); if (vre != null) setVinylReactive(vre);
        const ps = await idbGetMeta("positions"); if (ps) setPositions(ps);
        const lk = await idbGetMeta("liked"); if (lk) setLikedIds(lk);
        const pr = await idbGetMeta("playbackRate"); if (pr) setPlaybackRate(pr);
        const cf = await idbGetMeta("crossfadeSec"); if (cf != null) setCrossfadeSec(cf);
      } catch { /* fresh start */ }
      setLoaded(true);
    })();
  }, []);
  useEffect(() => { if (loaded) idbSetMeta("playlists", playlists); }, [playlists, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("lyrics", lyricsMap); }, [lyricsMap, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("playCounts", playCounts); }, [playCounts, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("recentlyPlayed", recentlyPlayed); }, [recentlyPlayed, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("tags", tagsMap); }, [tagsMap, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("celebratedMilestones", celebratedMilestones); }, [celebratedMilestones, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("theme", theme); }, [theme, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("vinylColor", vinylColor); }, [vinylColor, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("vinylBackdrop", vinylBackdrop); }, [vinylBackdrop, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("crackleEnabled", crackleEnabled); }, [crackleEnabled, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("vinylRPM", vinylRPM); }, [vinylRPM, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("vinylShine", vinylShine); }, [vinylShine, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("vinylDust", vinylDust); }, [vinylDust, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("vinylReactive", vinylReactive); }, [vinylReactive, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("positions", positions); }, [positions, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("liked", likedIds); }, [likedIds, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("playbackRate", playbackRate); }, [playbackRate, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("crossfadeSec", crossfadeSec); }, [crossfadeSec, loaded]);
  useEffect(() => { crossfadeSecRef.current = crossfadeSec; }, [crossfadeSec]);
  useEffect(() => {
    [audioARef.current, audioBRef.current].forEach((el) => { if (el) el.playbackRate = playbackRate; });
  }, [playbackRate]);

  // WOW #2 — dynamic color theme sampled from the real album art
  useEffect(() => {
    let cancelled = false;
    if (currentTrack?.artUrl) extractDominantColor(currentTrack.artUrl).then((c) => { if (!cancelled) setThemeColor(c); });
    else setThemeColor(null);
    return () => { cancelled = true; };
  }, [currentTrack?.id, currentTrack?.artUrl]);
  const accent = themeColor ? `rgb(${themeColor.r},${themeColor.g},${themeColor.b})` : currentTrack ? `hsl(${artHue(currentTrack.name)} 70% 55%)` : "#FA2D48";

  // Vinyl Mode 2.0 — floating dust-mote positions, generated once so the
  // ambience doesn't jitter/reshuffle on every re-render (currentTime ticks).
  const dustMotes = useMemo(() => Array.from({ length: 16 }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 100,
    size: 1 + Math.random() * 2.2,
    dur: 7 + Math.random() * 9,
    delay: -Math.random() * 12,
    drift: (Math.random() - 0.5) * 40,
  })), []);

  // ------------------------------------------------------------------
  const recentlyAdded = [...library].sort((a, b) => b.addedAt - a.addedAt).slice(0, 25);
  const recentlyPlayedTracks = recentlyPlayed.map((r) => library.find((t) => t.id === r.id)).filter(Boolean).slice(0, 25);
  const palette = THEMES[theme] || THEMES.amoled;
  const glassBar = theme === "light" ? "rgba(255,255,255,0.85)" : "rgba(20,20,22,0.85)";
  const glassPanel = theme === "light" ? "rgba(255,255,255,0.9)" : "rgba(44,44,46,0.85)";
  const sheetBg = theme === "light" ? "#FFFFFF" : palette.surface;
  const filteredTagLibrary = activeTagFilter ? library.filter((t) => (tagsMap[t.id] || []).includes(activeTagFilter)) : null;

  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weekAgo = Date.now() - weekMs;
  const weeklyPlays = recentlyPlayed.filter((r) => r.ts >= weekAgo);
  const weeklyCounts = {};
  weeklyPlays.forEach((r) => { weeklyCounts[r.id] = (weeklyCounts[r.id] || 0) + 1; });
  const weeklyTop = Object.entries(weeklyCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => ({ track: library.find((t) => t.id === id), count })).filter((x) => x.track);
  const weeklyMinutes = Math.round(weeklyPlays.reduce((sum, r) => sum + (library.find((t) => t.id === r.id)?.duration || 180), 0) / 60);
  const totalLifetimePlays = Object.values(playCounts).reduce((a, b) => a + b, 0);
  const mostPlayed = [...library].filter((t) => playCounts[t.id] > 0).sort((a, b) => (playCounts[b.id] || 0) - (playCounts[a.id] || 0)).slice(0, 25);
  const likedTracks = likedIds.map((id) => library.find((t) => t.id === id)).filter(Boolean);
  const toggleLike = (id) => setLikedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev]));

  const sortedLibrary = (() => {
    const arr = [...(filteredTagLibrary || library)];
    if (librarySort === "name") arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (librarySort === "duration") arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    else arr.sort((a, b) => b.addedAt - a.addedAt);
    return arr;
  })();
  const playlistTracks = activePlaylist ? activePlaylist.trackIds.map((tid) => library.find((t) => t.id === tid)).filter(Boolean) : [];

  // ------------------------------------------------------------------
  // Web Audio graph — TWO decks mixed together for real crossfade
  // deckA/B -> gainA/B -> mix -> bass -> mid -> treble -> analyser -> masterGain -> out
  // ------------------------------------------------------------------
  const ensureAudioGraph = useCallback(() => {
    if (audioCtxRef.current || !audioARef.current || !audioBRef.current) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const srcA = ctx.createMediaElementSource(audioARef.current);
    const srcB = ctx.createMediaElementSource(audioBRef.current);
    const gainA = ctx.createGain(); gainA.gain.value = 1;
    const gainB = ctx.createGain(); gainB.gain.value = 0;
    const mix = ctx.createGain();
    srcA.connect(gainA); gainA.connect(mix);
    srcB.connect(gainB); gainB.connect(mix);
    const bass = ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 200;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 1;
    const treble = ctx.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 64;
    const normGain = ctx.createGain(); normGain.gain.value = 1;
    const masterGain = ctx.createGain(); masterGain.gain.value = 1;
    mix.connect(bass); bass.connect(mid); mid.connect(treble); treble.connect(analyser); analyser.connect(normGain); normGain.connect(masterGain); masterGain.connect(ctx.destination);
    const crackleGain = ctx.createGain(); crackleGain.gain.value = 0;
    crackleGain.connect(ctx.destination);
    audioCtxRef.current = ctx; gainARef.current = gainA; gainBRef.current = gainB;
    analyserRef.current = analyser; masterGainRef.current = masterGain; normGainRef.current = normGain;
    crackleGainRef.current = crackleGain;
    eqRefs.current = { bass, mid, treble };
  }, []);

  useEffect(() => {
    const { bass, mid, treble } = eqRefs.current;
    if (bass) bass.gain.value = eqBands.bass;
    if (mid) mid.gain.value = eqBands.mid;
    if (treble) treble.gain.value = eqBands.treble;
  }, [eqBands]);

  useEffect(() => { normalizeVolumeRef.current = normalizeVolume; }, [normalizeVolume]);

  const fadeTo = (target, ms) => {
    const g = masterGainRef.current, ctx = audioCtxRef.current;
    if (!g || !ctx) return Promise.resolve();
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(target, now + ms / 1000);
    return new Promise((res) => setTimeout(res, ms));
  };

  // WOW (MD Vinyl-inspired) — synthesized vinyl crackle/hiss ambience, looped
  // quietly under the music while Vinyl Mode + the crackle toggle are on.
  const buildCrackleBuffer = () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return null;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      let s = (Math.random() * 2 - 1) * 0.015; // steady hiss floor
      if (Math.random() < 0.0025) s += (Math.random() * 2 - 1) * 0.35; // occasional pop
      data[i] = s;
    }
    return buf;
  };
  const startCrackle = () => {
    const ctx = audioCtxRef.current, gain = crackleGainRef.current;
    if (!ctx || !gain || crackleSourceRef.current) return;
    if (!crackleBufferRef.current) crackleBufferRef.current = buildCrackleBuffer();
    if (!crackleBufferRef.current) return;
    const src = ctx.createBufferSource();
    src.buffer = crackleBufferRef.current;
    src.loop = true;
    src.connect(gain);
    src.start();
    crackleSourceRef.current = src;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.4);
  };
  const stopCrackle = () => {
    const ctx = audioCtxRef.current, gain = crackleGainRef.current, src = crackleSourceRef.current;
    if (gain && ctx) { gain.gain.cancelScheduledValues(ctx.currentTime); gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3); }
    if (src) setTimeout(() => { try { src.stop(); } catch {} }, 350);
    crackleSourceRef.current = null;
  };
  useEffect(() => {
    if (vinylMode && crackleEnabled && isPlaying && audioCtxRef.current) startCrackle();
    else stopCrackle();
  }, [vinylMode, crackleEnabled, isPlaying]);

  // Synthesized tonearm needle drop/lift click — a short filtered noise
  // transient that fires when the stylus touches down or lifts off the
  // record, adding tactile realism to the drag-to-play tonearm gesture.
  const playNeedleClick = (kind = "down") => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const dur = 0.05;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = kind === "down" ? "lowpass" : "highpass";
    filter.frequency.value = kind === "down" ? 1200 : 2600;
    const g = ctx.createGain();
    g.gain.value = kind === "down" ? 0.5 : 0.3;
    src.connect(filter); filter.connect(g); g.connect(ctx.destination);
    src.start();
  };

  // ------------------------------------------------------------------
  useEffect(() => {
    const draw = () => {
      let level = 0, data = null;
      if (analyserRef.current && isPlaying) {
        data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        level = data.reduce((a, b) => a + b, 0) / data.length / 255;
      }
      const vu = vuCanvasRef.current;
      if (vu) {
        const c = vu.getContext("2d");
        const w = vu.width, h = vu.height;
        c.clearRect(0, 0, w, h);
        const bars = 24, gap = 3;
        const barW = (w - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i++) {
          let l = 0;
          if (data) l = data[Math.floor((i / bars) * data.length)] / 255;
          const barH = Math.max(2, l * h);
          c.fillStyle = l > 0.82 ? "#FF375F" : accent;
          c.fillRect(i * (barW + gap), h - barH, barW, barH);
        }
      }
      const wave = waveCanvasRef.current;
      if (wave) {
        const c = wave.getContext("2d");
        const w = wave.width, h = wave.height;
        c.clearRect(0, 0, w, h);
        const peaks = currentTrack?.peaks;
        const dur = duration || currentTrack?.duration || 0;
        const progressRatio = dur ? currentTime / dur : 0;
        if (peaks && peaks.length) {
          const barW = w / peaks.length;
          peaks.forEach((p, i) => {
            const barH = Math.max(2, p * (h - 4));
            const x = i * barW, y = (h - barH) / 2;
            c.fillStyle = i / peaks.length < progressRatio ? accent : "rgba(255,255,255,0.25)";
            c.fillRect(x, y, Math.max(1, barW - 1), barH);
          });
        } else {
          c.fillStyle = "rgba(255,255,255,0.2)"; c.fillRect(0, h / 2 - 1, w, 2);
          c.fillStyle = accent; c.fillRect(0, h / 2 - 1, w * progressRatio, 2);
        }
        if (loopA != null && dur) {
          const xA = (loopA / dur) * w;
          const xB = loopB != null ? (loopB / dur) * w : xA;
          c.fillStyle = "rgba(255,255,255,0.12)";
          c.fillRect(xA, 0, Math.max(2, xB - xA), h);
          c.fillStyle = "#FFD60A";
          c.fillRect(xA - 1, 0, 2, h);
          if (loopB != null) c.fillRect(xB - 1, 0, 2, h);
        }
      }
      if (bgGlowRef.current) {
        bgGlowRef.current.style.transform = `scale(${1 + level * 0.18})`;
        bgGlowRef.current.style.opacity = String(0.5 + level * 0.35);
      }
      // Vinyl Mode 2.0 — the record subtly breathes/glows with the music,
      // driven directly on the DOM node (no re-render) for smooth 60fps feel.
      if (vinylPulseRef.current) {
        if (vinylMode && vinylReactive && isPlaying) {
          vinylPulseRef.current.style.opacity = String(0.18 + level * 0.55);
          vinylPulseRef.current.style.transform = `scale(${1 + level * 0.07})`;
        } else {
          vinylPulseRef.current.style.opacity = "0";
        }
      }
      // WOW — loudness normalization: gently nudge gain so quiet and loud
      // tracks land closer to a similar perceived volume.
      if (normGainRef.current && audioCtxRef.current) {
        if (normalizeVolumeRef.current && isPlaying && level > 0.02) {
          normLevelRef.current = normLevelRef.current * 0.97 + level * 0.03;
          const target = Math.max(0.4, Math.min(2.2, 0.5 / normLevelRef.current));
          const g = normGainRef.current.gain;
          const now = audioCtxRef.current.currentTime;
          g.setTargetAtTime(target, now, 0.6);
        } else {
          normGainRef.current.gain.setTargetAtTime(1, audioCtxRef.current.currentTime, 0.6);
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, currentTrack, currentTime, duration, accent, loopA, loopB, vinylMode, vinylReactive]);

  useEffect(() => {
    const resize = () => {
      if (waveCanvasRef.current && waveWrapRef.current) { waveCanvasRef.current.width = waveWrapRef.current.clientWidth; waveCanvasRef.current.height = 44; }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [nowPlayingOpen]);

  // ------------------------------------------------------------------
  // File import
  // ------------------------------------------------------------------
  const importFiles = async (fileList) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("audio/") || /\.(mp3|flac|wav|m4a|ogg|opus)$/i.test(f.name));
    if (files.length === 0) return;
    const existingNames = new Set(library.map((t) => (t.name + "." + t.ext).toLowerCase()));
    let dupeCount = 0;
    const drafts = files.map((f) => {
      if (existingNames.has(f.name.toLowerCase())) dupeCount++;
      return { id: uid(), name: f.name.replace(/\.[^/.]+$/, ""), ext: f.name.split(".").pop().toUpperCase(), file: f, duration: 0, peaks: null, addedAt: Date.now(), artUrl: null };
    });
    setLibrary((prev) => [...prev, ...drafts]);
    showToast(`Added ${drafts.length} track${drafts.length !== 1 ? "s" : ""}${dupeCount ? ` (${dupeCount} possible duplicate${dupeCount !== 1 ? "s" : ""})` : ""}`);
    for (const d of drafts) {
      idbPutTrack({ id: d.id, name: d.name, ext: d.ext, duration: 0, peaks: null, addedAt: d.addedAt, blob: d.file, artBlob: null });
      const [{ peaks, duration, trimStart, trimEnd }, artBlob] = await Promise.all([computePeaks(d.file), extractEmbeddedArt(d.file)]);
      const artUrl = artBlob ? URL.createObjectURL(artBlob) : null;
      setLibrary((prev) => prev.map((t) => (t.id === d.id ? { ...t, peaks, duration: duration || t.duration, artUrl, trimStart, trimEnd } : t)));
      idbPutTrack({ id: d.id, name: d.name, ext: d.ext, duration: duration || 0, peaks, addedAt: d.addedAt, blob: d.file, artBlob, trimStart, trimEnd });
    }
  };
  const onFileInputChange = (e) => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ""; };
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) importFiles(e.dataTransfer.files); };

  // ------------------------------------------------------------------
  // WOW #1 — dual-deck playback engine with true overlapping crossfade
  // ------------------------------------------------------------------
  const loadTrackById = async (id, autoplay = true) => {
    const track = library.find((t) => t.id === id);
    if (!track) return;
    ensureAudioGraph();
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();

    const prevDeck = activeDeckRef.current;
    const prevAudio = deckAudio(prevDeck);
    if (currentTrack && prevAudio) setPositions((prev) => ({ ...prev, [currentTrack.id]: prevAudio.currentTime }));

    const doCrossfade = isPlaying && !crossfadingRef.current;
    const targetDeck = doCrossfade ? otherDeck(prevDeck) : prevDeck;
    const targetAudio = deckAudio(targetDeck);
    const targetGain = deckGain(targetDeck);
    const tUrlRef = deckUrlRef(targetDeck);

    if (tUrlRef.current) { URL.revokeObjectURL(tUrlRef.current); tUrlRef.current = null; }
    const url = URL.createObjectURL(track.file);
    tUrlRef.current = url;

    setCurrentTime(0);
    setLoopA(null); setLoopB(null);
    resumeSeekRef.current = positions[id] > 3 ? positions[id] : (track.trimStart > 0.3 ? track.trimStart : null);
    setRecentlyPlayed((prev) => [{ id, ts: Date.now() }, ...prev.filter((r) => r.id !== id)].slice(0, 200));
    checkMilestone();
    setPlayCounts((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));

    targetAudio.src = url;
    targetAudio.currentTime = 0;
    targetAudio.playbackRate = playbackRate;

    const cfSec = crossfadeSecRef.current;
    if (doCrossfade && cfSec > 0) {
      crossfadingRef.current = true;
      const ctx = audioCtxRef.current;
      const now = ctx.currentTime;
      targetGain.gain.cancelScheduledValues(now); targetGain.gain.setValueAtTime(0, now); targetGain.gain.linearRampToValueAtTime(1, now + cfSec);
      const prevGain = deckGain(prevDeck);
      prevGain.gain.cancelScheduledValues(now); prevGain.gain.setValueAtTime(prevGain.gain.value, now); prevGain.gain.linearRampToValueAtTime(0, now + cfSec);
      targetAudio.play().catch(() => {});
      activeDeckRef.current = targetDeck;
      setIsPlaying(true);
      setTimeout(() => { try { prevAudio.pause(); } catch {} crossfadingRef.current = false; }, cfSec * 1000 + 80);
    } else {
      crossfadingRef.current = false;
      const other = otherDeck(targetDeck);
      try { deckAudio(other).pause(); } catch {}
      if (audioCtxRef.current) {
        deckGain(other).gain.setValueAtTime(0, audioCtxRef.current.currentTime);
        targetGain.gain.setValueAtTime(1, audioCtxRef.current.currentTime);
      }
      activeDeckRef.current = targetDeck;
      if (autoplay) { targetAudio.play().catch(() => {}); setIsPlaying(true); }
    }
  };

  useEffect(() => () => { if (urlARef.current) URL.revokeObjectURL(urlARef.current); if (urlBRef.current) URL.revokeObjectURL(urlBRef.current); }, []);

  const playFrom = (list, index, sourceLabel) => {
    const ids = list.map((t) => t.id);
    setQueue(ids); setQueueIndex(index); setQueueSource(sourceLabel);
    loadTrackById(ids[index], true);
  };

  const togglePlay = () => {
    const a = deckAudio(activeDeckRef.current);
    if (!a || !currentTrack) return;
    ensureAudioGraph();
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
    if (isPlaying) { a.pause(); setIsPlaying(false); } else { a.play().catch(() => {}); setIsPlaying(true); }
  };

  const stepTrack = (dir) => {
    if (!queue.length) return;
    let idx = queueIndex;
    if (shuffle) {
      let next = Math.floor(Math.random() * queue.length);
      if (queue.length > 1) while (next === idx) next = Math.floor(Math.random() * queue.length);
      setQueueIndex(next); loadTrackById(queue[next], true);
      return;
    }
    let next = idx + dir;
    if (next < 0) next = queue.length - 1;
    if (next >= queue.length) next = 0;
    setQueueIndex(next); loadTrackById(queue[next], true);
  };

  const handleAutoAdvance = () => {
    if (repeatMode === "one") { const a = deckAudio(activeDeckRef.current); a.currentTime = 0; a.play(); return; }
    const isLast = queueIndex === queue.length - 1;
    if (isLast && repeatMode === "off" && !shuffle) { if (!appendSmartContinuation()) return; }
    stepTrack(1);
  };

  const cycleRepeat = () => setRepeatMode((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"));

  // WOW — A/B repeat loop: tap once to mark the start, again to mark the
  // end and start looping that section, a third tap clears it.
  const handleLoopTap = () => {
    if (loopA == null) { setLoopA(currentTime); showToast("Loop start set — tap again to set the end"); }
    else if (loopB == null) {
      if (currentTime > loopA + 0.5) { setLoopB(currentTime); showToast("Looping section"); }
      else { setLoopA(null); showToast("Loop cancelled — points too close together"); }
    } else { setLoopA(null); setLoopB(null); showToast("Loop cleared"); }
  };

  const seekTo = (t) => {
    const a = deckAudio(activeDeckRef.current);
    if (!a) return;
    const clamped = Math.max(0, Math.min(duration || 0, t));
    a.currentTime = clamped; setCurrentTime(clamped);
  };
  const onWaveClick = (e) => {
    if (!waveCanvasRef.current || !duration) return;
    const rect = waveCanvasRef.current.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  };

  // Vinyl Mode 2.0 — grab the spinning record itself and scrub/scratch
  // through the track like a real turntable, complete with needle
  // drop/lift clicks and a pause-while-scratching feel.
  const angleFromCenter = (touch, rect) => {
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    return { angle: Math.atan2(touch.clientY - cy, touch.clientX - cx) * (180 / Math.PI), cx, cy };
  };
  const onDiscTouchStart = (e) => {
    if (!currentTrack) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const { angle, cx, cy } = angleFromCenter(e.touches[0], rect);
    const wasPlaying = isPlaying;
    if (wasPlaying) { const a = deckAudio(activeDeckRef.current); a.pause(); setIsPlaying(false); }
    scratchRef.current = { cx, cy, lastAngle: angle, wasPlaying };
    setScratchDragging(true);
    setScratchAngle(0);
    playNeedleClick("down");
  };
  const onDiscTouchMove = (e) => {
    if (!scratchRef.current) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const { angle } = angleFromCenter(e.touches[0], rect);
    let delta = angle - scratchRef.current.lastAngle;
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    scratchRef.current.lastAngle = angle;
    setScratchAngle((a) => a + delta);
    seekTo(currentTime + delta * 0.05);
  };
  const onDiscTouchEnd = (e) => {
    if (!scratchRef.current) return;
    e.stopPropagation();
    const wasPlaying = scratchRef.current.wasPlaying;
    scratchRef.current = null;
    setScratchDragging(false);
    setScratchAngle(0);
    playNeedleClick("up");
    if (wasPlaying) { const a = deckAudio(activeDeckRef.current); a.play().catch(() => {}); setIsPlaying(true); }
  };
  const onVolumeChange = (e) => {
    const v = Number(e.target.value); setVolume(v); setMuted(false);
    if (masterGainRef.current) {} // master gain reserved for fades; user volume applied per element below
    [audioARef.current, audioBRef.current].forEach((el) => { if (el) el.volume = v; });
  };
  useEffect(() => {
    const v = muted ? 0 : volume;
    [audioARef.current, audioBRef.current].forEach((el) => { if (el) el.volume = v; });
  }, [volume, muted]);

  const onTimeUpdateFor = (deck) => (e) => {
    if (activeDeckRef.current !== deck) return;
    const t = e.target.currentTime;
    setCurrentTime(t);
    if (currentTrack && t - lastSaveRef.current > 5) { lastSaveRef.current = t; setPositions((prev) => ({ ...prev, [currentTrack.id]: t })); }
    if (loopA != null && loopB != null && t >= loopB) { const a = deckAudio(deck); a.currentTime = loopA; setCurrentTime(loopA); return; }
    const effectiveEnd = duration - (currentTrack?.trimEnd || 0);
    const cfSec = crossfadeSecRef.current;
    if (isPlaying && !crossfadingRef.current && cfSec > 0 && duration > cfSec * 2 && effectiveEnd - t <= cfSec) handleAutoAdvance();
  };
  const onLoadedMetadataFor = (deck) => (e) => {
    if (activeDeckRef.current !== deck) return;
    setDuration(e.target.duration);
    if (resumeSeekRef.current) { e.target.currentTime = resumeSeekRef.current; setCurrentTime(resumeSeekRef.current); resumeSeekRef.current = null; }
  };
  const onEndedFor = (deck) => () => {
    if (activeDeckRef.current !== deck || crossfadingRef.current) return;
    if (repeatMode === "one") { const a = deckAudio(deck); a.currentTime = 0; a.play(); return; }
    const isLast = queueIndex === queue.length - 1;
    if (isLast && repeatMode === "off" && !shuffle) { if (!appendSmartContinuation()) { setIsPlaying(false); return; } }
    stepTrack(1);
  };
  const onAudioErrorFor = (deck) => () => {
    if (activeDeckRef.current !== deck || !currentTrack) return;
    const a = deckAudio(deck), r = deckUrlRef(deck);
    if (r.current) URL.revokeObjectURL(r.current);
    const url = URL.createObjectURL(currentTrack.file);
    r.current = url; a.src = url;
    if (isPlaying) a.play().catch(() => {});
  };

  // ------------------------------------------------------------------
  const playNext = (trackId) => {
    if (!queue.length) { playFrom(library.filter((t) => t.id === trackId), 0, "Now Playing"); showToast("Playing now"); return; }
    setQueue((prev) => { const arr = [...prev]; arr.splice(queueIndex + 1, 0, trackId); return arr; });
    showToast("Playing next");
  };
  const playLater = (trackId) => {
    if (!queue.length) { playFrom(library.filter((t) => t.id === trackId), 0, "Now Playing"); showToast("Playing now"); return; }
    setQueue((prev) => [...prev, trackId]);
    showToast("Added to queue");
  };
  const removeFromQueue = (idx) => { setQueue((prev) => prev.filter((_, i) => i !== idx)); if (idx < queueIndex) setQueueIndex((q) => q - 1); };
  const reorderQueue = (fromIdx, toIdx) => {
    if (fromIdx == null || fromIdx === toIdx) return;
    setQueue((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      let newIdx = queueIndex;
      if (fromIdx === queueIndex) newIdx = toIdx;
      else if (fromIdx < queueIndex && toIdx >= queueIndex) newIdx -= 1;
      else if (fromIdx > queueIndex && toIdx <= queueIndex) newIdx += 1;
      setQueueIndex(newIdx);
      return arr;
    });
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight") seekTo(currentTime + 5);
      else if (e.key === "ArrowLeft") seekTo(currentTime - 5);
      else if (e.key === "n" || e.key === "N") stepTrack(1);
      else if (e.key === "p" || e.key === "P") stepTrack(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: currentTrack.name, artist: "Spool", album: "",
      artwork: currentTrack.artUrl ? [{ src: currentTrack.artUrl, sizes: "512x512", type: "image/png" }] : [],
    });
  }, [currentTrack]);
  useEffect(() => { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused"; }, [isPlaying]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => stepTrack(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => stepTrack(1));
    navigator.mediaSession.setActionHandler("seekto", (d) => { if (d.seekTime != null) seekTo(d.seekTime); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queueIndex, shuffle, repeatMode, isPlaying, duration]);

  // WOW — keep playing in the background: some mobile browsers suspend the
  // AudioContext when the app is backgrounded even though playback should
  // continue. Auto-resume it the moment it drops to "suspended" while we
  // still think we're playing. This covers normal backgrounding (switching
  // apps, screen lock) — it can't survive the OS fully force-killing the
  // browser/PWA process, no website can do that, it's a hard platform limit.
  useEffect(() => {
    const resumeIfNeeded = () => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended" && isPlaying) ctx.resume().catch(() => {});
    };
    document.addEventListener("visibilitychange", resumeIfNeeded);
    const iv = setInterval(resumeIfNeeded, 2000);
    return () => { document.removeEventListener("visibilitychange", resumeIfNeeded); clearInterval(iv); };
  }, [isPlaying]);

  // WOW — smooth closing: pressing the hardware/gesture back button while
  // Now Playing (or any sheet) is open closes just that screen first, with
  // its normal spring animation, instead of abruptly exiting the app.
  useEffect(() => {
    const anySheetOpen = nowPlayingOpen || contextTrackId || addSheetTrackId || infoSheetTrackId || newPlaylistSheet || bulkAddSheetOpen || showStats || showSettings || tagSheetTrackId || bulkAddSheetOpen || renameTrackId;
    if (anySheetOpen) {
      window.history.pushState({ spoolSheet: true }, "");
      const onPopState = () => {
        setNowPlayingOpen(false); closeContext(); setAddSheetTrackId(null); setInfoSheetTrackId(null);
        setNewPlaylistSheet(false); setBulkAddSheetOpen(false); setShowStats(false); setShowSettings(false); setTagSheetTrackId(null); setRenameTrackId(null);
      };
      window.addEventListener("popstate", onPopState);
      return () => window.removeEventListener("popstate", onPopState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlayingOpen, contextTrackId, addSheetTrackId, infoSheetTrackId, newPlaylistSheet, bulkAddSheetOpen, showStats, showSettings, tagSheetTrackId, renameTrackId]);

  // WOW — dynamic status bar / PWA chrome color that hints at the playing
  // track's color without ever looking off — blended heavily toward black
  // so it always stays dark and cohesive with the rest of the app.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    if (!currentTrack) { meta.setAttribute("content", palette.bg); return; }
    let statusColor = palette.bg;
    const rgbMatch = accent.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    const hslMatch = accent.match(/hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/);
    if (rgbMatch) {
      const r = Math.round(parseInt(rgbMatch[1]) * 0.22);
      const g = Math.round(parseInt(rgbMatch[2]) * 0.22);
      const b = Math.round(parseInt(rgbMatch[3]) * 0.22);
      statusColor = `rgb(${r},${g},${b})`;
    } else if (hslMatch) {
      statusColor = `hsl(${hslMatch[1]} 40% 12%)`;
    }
    meta.setAttribute("content", statusColor);
  }, [accent, currentTrack, palette.bg]);

  const setSleepMinutes = (mins) => {
    clearTimeout(sleepTimeoutRef.current); clearTimeout(sleepFadeTimeoutRef.current);
    if (!mins) {
      setSleepEndsAt(null); setSleepRemaining(null); setShowSleep(false);
      if (masterGainRef.current && audioCtxRef.current) masterGainRef.current.gain.setValueAtTime(1, audioCtxRef.current.currentTime);
      return;
    }
    const totalMs = mins * 60000;
    const fadeLead = Math.min(15000, totalMs * 0.3);
    const end = Date.now() + totalMs;
    setSleepEndsAt(end); setShowSleep(false);
    sleepFadeTimeoutRef.current = setTimeout(() => fadeTo(0, fadeLead), totalMs - fadeLead);
    sleepTimeoutRef.current = setTimeout(() => {
      const a = deckAudio(activeDeckRef.current); if (a) a.pause();
      setIsPlaying(false); setSleepEndsAt(null); setSleepRemaining(null);
      if (masterGainRef.current && audioCtxRef.current) masterGainRef.current.gain.setValueAtTime(1, audioCtxRef.current.currentTime);
    }, totalMs);
  };
  useEffect(() => {
    if (!sleepEndsAt) return;
    const iv = setInterval(() => { const remain = Math.max(0, sleepEndsAt - Date.now()); setSleepRemaining(remain); if (remain <= 0) clearInterval(iv); }, 1000);
    return () => clearInterval(iv);
  }, [sleepEndsAt]);

  // ------------------------------------------------------------------
  // WOW — milestone celebrations
  const checkMilestone = () => {
    const total = Object.values(playCounts).reduce((a, b) => a + b, 0) + 1;
    const hit = MILESTONES.find((m) => m === total);
    if (hit && !celebratedMilestones.includes(hit)) {
      setCelebratedMilestones((prev) => [...prev, hit]);
      setConfettiMilestone(hit);
      showToast(`🎉 ${hit} songs played!`);
      setTimeout(() => setConfettiMilestone(null), 2200);
    }
  };

  // WOW — smart continue: when the queue naturally runs out, keep the
  // vibe going instead of going silent, by queuing a few more tracks
  // (same mood tag when available, otherwise a random pick).
  const appendSmartContinuation = () => {
    if (!smartContinueEnabled || library.length === 0) return false;
    const current = library.find((t) => t.id === queue[queueIndex]);
    const tags = current ? tagsMap[current.id] || [] : [];
    let pool = library.filter((t) => !queue.includes(t.id));
    if (pool.length === 0) pool = library.filter((t) => t.id !== current?.id);
    if (pool.length === 0) return false;
    const tagged = tags.length ? pool.filter((t) => (tagsMap[t.id] || []).some((tag) => tags.includes(tag))) : [];
    const source = tagged.length ? tagged : pool;
    const picks = [];
    const copy = [...source];
    for (let i = 0; i < Math.min(5, copy.length); i++) {
      const idx = Math.floor(Math.random() * copy.length);
      picks.push(copy.splice(idx, 1)[0].id);
    }
    setQueue((prev) => [...prev, ...picks]);
    showToast("Continuing with similar songs");
    return true;
  };

  // WOW — mood tags
  const toggleTag = (trackId, tag) => {
    setTagsMap((prev) => {
      const cur = prev[trackId] || [];
      const next = cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag];
      return { ...prev, [trackId]: next };
    });
  };

  // WOW — folder import: groups files by their parent folder into playlists
  const importFolder = async (fileList) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("audio/") || /\.(mp3|flac|wav|m4a|ogg|opus)$/i.test(f.name));
    if (files.length === 0) return;
    const byFolder = {};
    files.forEach((f) => {
      const rel = f.webkitRelativePath || "";
      const parts = rel.split("/");
      const folder = parts.length > 2 ? parts[parts.length - 2] : "Imported Folder";
      byFolder[folder] = byFolder[folder] || [];
      byFolder[folder].push(f);
    });
    await importFiles(files);
    // give importFiles a tick to register ids, then build playlists by matching names
    setTimeout(() => {
      Object.entries(byFolder).forEach(([folder, folderFiles]) => {
        const names = folderFiles.map((f) => f.name.replace(/\.[^/.]+$/, ""));
        setLibrary((curLib) => {
          const ids = curLib.filter((t) => names.includes(t.name)).map((t) => t.id);
          if (ids.length) setPlaylists((prev) => [...prev, { id: uid(), name: folder, trackIds: ids }]);
          return curLib;
        });
      });
      showToast(`Created ${Object.keys(byFolder).length} playlist(s) from folders`);
    }, 800);
  };

  // WOW — playlist backup / export & import (structure only; audio stays local)
  const exportPlaylists = () => {
    const data = playlists.map((p) => ({ name: p.name, tracks: p.trackIds.map((id) => library.find((t) => t.id === id)?.name).filter(Boolean) }));
    const blob = new Blob([JSON.stringify({ app: "Spool", exportedAt: new Date().toISOString(), playlists: data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "spool-playlists.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("Playlists exported");
  };
  const importPlaylistsFile = async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let restored = 0, missing = 0;
      (data.playlists || []).forEach((p) => {
        const ids = p.tracks.map((name) => library.find((t) => t.name === name)?.id).filter(Boolean);
        missing += p.tracks.length - ids.length;
        if (ids.length) { setPlaylists((prev) => [...prev, { id: uid(), name: p.name, trackIds: ids }]); restored++; }
      });
      showToast(`Restored ${restored} playlist(s)${missing ? ` — ${missing} track(s) not found in your library` : ""}`);
    } catch { showToast("Couldn't read that backup file"); }
  };

  // WOW — storage meter
  const refreshStorageEstimate = async () => {
    try {
      if (navigator.storage?.estimate) { const est = await navigator.storage.estimate(); setStorageEstimate(est); }
    } catch { setStorageEstimate(null); }
  };

  // WOW — floating mini-player via Picture-in-Picture (renders album art into a tiny video)
  const startFloatingPlayer = async () => {
    try {
      if (!currentTrack) return;
      const canvas = pipCanvasRef.current;
      const video = pipVideoRef.current;
      canvas.width = 400; canvas.height = 400;
      const ctx2d = canvas.getContext("2d");
      let artImg = null;
      if (currentTrack.artUrl) {
        artImg = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = currentTrack.artUrl;
        });
      }
      const drawFrame = () => {
        ctx2d.fillStyle = "#000"; ctx2d.fillRect(0, 0, 400, 400);
        if (artImg) {
          ctx2d.drawImage(artImg, 0, 0, 400, 400);
        } else {
          const grad = ctx2d.createLinearGradient(0, 0, 400, 400);
          grad.addColorStop(0, accent); grad.addColorStop(1, "#000");
          ctx2d.fillStyle = grad; ctx2d.fillRect(0, 0, 400, 400);
        }
        ctx2d.fillStyle = "#fff"; ctx2d.font = "24px sans-serif";
        ctx2d.fillText(currentTrack?.name?.slice(0, 20) || "", 16, 370);
      };
      drawFrame();
      const stream = canvas.captureStream(2);
      video.srcObject = stream;
      await video.play();
      if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
      else showToast("Floating player not supported on this browser");
    } catch { showToast("Floating player not supported on this browser"); }
  };

  // WOW — shareable playlist card
  const sharePlaylistCard = async (playlist) => {
    try {
      const tracks = playlist.trackIds.map((id) => library.find((t) => t.id === id)).filter(Boolean);
      const canvas = document.createElement("canvas");
      canvas.width = 600; canvas.height = 750;
      const ctx2d = canvas.getContext("2d");
      ctx2d.fillStyle = "#0A0A0A"; ctx2d.fillRect(0, 0, 600, 750);
      tracks.slice(0, 4).forEach((t, i) => {
        const h = artHue(t.name);
        ctx2d.fillStyle = `hsl(${h} 70% 40%)`;
        ctx2d.fillRect((i % 2) * 300, Math.floor(i / 2) * 300, 300, 300);
      });
      ctx2d.fillStyle = "#fff"; ctx2d.font = "bold 34px sans-serif";
      ctx2d.fillText(playlist.name, 24, 660);
      ctx2d.fillStyle = "#98989D"; ctx2d.font = "20px sans-serif";
      ctx2d.fillText(`${tracks.length} songs · Made with Spool`, 24, 700);
      canvas.toBlob(async (blob) => {
        const file = new File([blob], `${playlist.name}.png`, { type: "image/png" });
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: playlist.name });
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href = url; a.download = `${playlist.name}.png`; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
      }, "image/png");
    } catch { showToast("Couldn't create the share card"); }
  };

  const createPlaylist = () => {
    const name = newPlaylistName.trim();
    if (!name) return;
    const pl = { id: uid(), name, trackIds: newPlaylistFromQueue ? Array.from(new Set(queue)) : [] };
    setPlaylists((prev) => [...prev, pl]);
    setNewPlaylistName(""); setNewPlaylistSheet(false); setOpenPlaylistId(pl.id); setNewPlaylistFromQueue(false);
    showToast(newPlaylistFromQueue ? "Queue saved as playlist" : "Playlist created");
  };
  const deletePlaylist = (id) => { setPlaylists((prev) => prev.filter((p) => p.id !== id)); if (openPlaylistId === id) setOpenPlaylistId(null); showToast("Playlist deleted"); };
  const addToPlaylist = (playlistId, trackId) => {
    setPlaylists((prev) => prev.map((p) => (p.id === playlistId && !p.trackIds.includes(trackId) ? { ...p, trackIds: [...p.trackIds, trackId] } : p)));
    setAddSheetTrackId(null); showToast("Added to playlist");
  };
  const removeFromPlaylist = (playlistId, trackId) => {
    setPlaylists((prev) => prev.map((p) => (p.id === playlistId ? { ...p, trackIds: p.trackIds.filter((t) => t !== trackId) } : p)));
    showToast("Removed from playlist");
  };
  const deleteFromLibrary = (trackId) => {
    setLibrary((prev) => prev.filter((t) => t.id !== trackId));
    setPlaylists((prev) => prev.map((p) => ({ ...p, trackIds: p.trackIds.filter((t) => t !== trackId) })));
    setQueue((prev) => prev.filter((id) => id !== trackId));
    idbDeleteTrack(trackId);
    showToast("Deleted");
  };

  // WOW — rename a track's display title (e.g. fix a messy filename)
  const renameTrack = async (trackId, newName) => {
    const name = newName.trim();
    if (!name) return;
    setLibrary((prev) => prev.map((t) => (t.id === trackId ? { ...t, name } : t)));
    try {
      const record = await idbGetTrack(trackId);
      if (record) await idbPutTrack({ ...record, name });
    } catch { /* rename still applied in-session even if persistence fails */ }
    setRenameTrackId(null);
    showToast("Renamed");
  };

  // WOW #5 — multi-select bulk actions
  const toggleSelect = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const clearSelection = () => { setSelectMode(false); setSelectedIds([]); };
  const bulkDelete = () => {
    setLibrary((prev) => prev.filter((t) => !selectedIds.includes(t.id)));
    setPlaylists((prev) => prev.map((p) => ({ ...p, trackIds: p.trackIds.filter((id) => !selectedIds.includes(id)) })));
    setQueue((prev) => prev.filter((id) => !selectedIds.includes(id)));
    selectedIds.forEach((id) => idbDeleteTrack(id));
    showToast(`${selectedIds.length} deleted`);
    clearSelection();
  };
  const bulkAddToPlaylist = (playlistId) => {
    setPlaylists((prev) => prev.map((p) => (p.id === playlistId ? { ...p, trackIds: Array.from(new Set([...p.trackIds, ...selectedIds])) } : p)));
    showToast("Added to playlist");
    setBulkAddSheetOpen(false);
    clearSelection();
  };
  const bulkPlay = () => {
    const tracks = library.filter((t) => selectedIds.includes(t.id));
    if (tracks.length) playFrom(tracks, 0, "Selected");
    clearSelection();
  };

  // WOW — one-tap shuffle of the entire library
  const shuffleAll = () => {
    if (!library.length) return;
    const shuffled = [...library];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setShuffle(true);
    playFrom(shuffled, 0, "Shuffle All");
  };

  const onSheetTouchStart = (e) => { touchStartY.current = e.touches[0].clientY; setDragging(true); };
  const onSheetTouchMove = (e) => { const dy = e.touches[0].clientY - touchStartY.current; if (dy > 0) setDragY(dy); };
  const onSheetTouchEnd = () => { setDragging(false); if (dragY > 110) setNowPlayingOpen(false); setDragY(0); };
  const onArtTouchStart = (e) => { artTouchStartX.current = e.touches[0].clientX; };
  const onArtTouchMove = (e) => { setArtSwipeX(e.touches[0].clientX - artTouchStartX.current); };
  const onArtTouchEnd = () => { if (artSwipeX < -70) stepTrack(1); else if (artSwipeX > 70) stepTrack(-1); setArtSwipeX(0); };

  const q = searchQuery.trim().toLowerCase();
  const searchLibraryResults = q ? library.filter((t) => t.name.toLowerCase().includes(q)) : [];
  const searchPlaylistResults = q
    ? playlists.map((p) => ({ playlist: p, tracks: p.trackIds.map((id) => library.find((t) => t.id === id)).filter((t) => t && t.name.toLowerCase().includes(q)) })).filter((r) => r.tracks.length > 0)
    : [];

  const openContext = (trackId, mode, playlistId = null) => { setContextTrackId(trackId); setContextInfo({ mode, playlistId }); };
  const closeContext = () => { setContextTrackId(null); setContextInfo(null); };

  // ==================================================================
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden select-none" style={{ background: palette.bg, color: palette.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        input[type="range"] { -webkit-appearance:none; appearance:none; height:4px; background:rgba(255,255,255,0.2); border-radius:999px; outline:none; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:16px; height:16px; border-radius:50%; background:#FFFFFF; cursor:pointer; }
        input[type="range"]::-moz-range-thumb { width:16px; height:16px; border-radius:50%; background:#FFFFFF; cursor:pointer; border:none; }
        input[type="range"].vert { writing-mode: vertical-lr; direction: rtl; width:4px; height:90px; }
        ::-webkit-scrollbar { display: none; }
        .press:active { transform: scale(0.93) translateY(0.5px); filter: brightness(0.94); }
        .press { transition: transform 0.15s ${SPRING}, filter 0.15s; }
        .sheet-enter { animation: slideUp 0.28s ${SPRING}; }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .eq-bar { width: 3px; background: #FA2D48; border-radius: 2px; animation: eqPulse 0.9s ease-in-out infinite; box-shadow: 0 0 4px rgba(250,45,72,0.7); }
        @keyframes eqPulse { 0%,100% { height: 4px; } 50% { height: 14px; } }
        .hscroll { display: flex; overflow-x: auto; gap: 12px; scroll-snap-type: x proximity; }
        .hscroll > * { scroll-snap-align: start; }
        .fade-in { animation: fadeIn 0.2s ease-out; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @media (orientation: landscape) and (max-height: 520px) {
          .np-player-body { flex-direction: row; align-items: center; justify-content: center; gap: 28px; padding-left: 24px; padding-right: 24px; overflow-y: auto; }
          .np-player-body .np-art { width: 38vh; max-width: 38vh; height: 38vh; flex-shrink: 0; }
          .np-player-body .np-controls-col { width: auto; max-width: 360px; }
        }

        /* ---- Liquid Glass system ---- */
        .glass {
          background: rgba(255,255,255,0.07);
          backdrop-filter: blur(28px) saturate(190%);
          -webkit-backdrop-filter: blur(28px) saturate(190%);
          border: 1px solid rgba(255,255,255,0.14);
          box-shadow: 0 10px 34px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -10px 20px -12px rgba(0,0,0,0.25);
          position: relative;
        }
        .glass-light {
          background: rgba(0,0,0,0.05) !important;
          border: 1px solid rgba(0,0,0,0.08) !important;
          box-shadow: 0 10px 30px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.6) !important;
        }
        .glass::before {
          content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
          background: linear-gradient(120deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.02) 32%, transparent 55%);
        }
        .glass-tile {
          position: relative; overflow: hidden;
          box-shadow: 0 6px 16px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -6px 12px -8px rgba(0,0,0,0.5);
          transform: translateZ(0);
        }
        .glass-tile::after {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(135deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 26%, rgba(0,0,0,0.12) 100%);
        }
        .glass-pill {
          background: rgba(255,255,255,0.09);
          backdrop-filter: blur(16px) saturate(180%);
          -webkit-backdrop-filter: blur(16px) saturate(180%);
          border: 1px solid rgba(255,255,255,0.14);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), 0 4px 10px rgba(0,0,0,0.25);
        }
        .press-3d { transform-style: preserve-3d; transition: transform 0.16s cubic-bezier(0.32,0.72,0,1), box-shadow 0.16s; }
        .press-3d:active { transform: scale(0.93) translateY(1px); box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
        .shine-sweep { position: relative; overflow: hidden; }
        .shine-sweep::after {
          content: ""; position: absolute; top: -60%; left: -60%; width: 40%; height: 220%;
          background: linear-gradient(120deg, transparent, rgba(255,255,255,0.35), transparent);
          transform: rotate(20deg); animation: shineMove 4.5s ease-in-out infinite;
        }
        @keyframes shineMove { 0% { left: -60%; } 45% { left: 130%; } 100% { left: 130%; } }
      `}</style>

      {toast && <div className="fade-in absolute top-3 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-xs font-medium" style={{ background: "rgba(40,40,42,0.95)", zIndex: 70, backdropFilter: "blur(20px)" }}>{toast}</div>}

      <header className="flex items-center justify-between px-4 shrink-0" style={{ height: 54, background: palette.bg, color: palette.text }}>
        <h1 className="text-2xl font-extrabold tracking-tight">{activeTab === "home" ? "Home" : activeTab === "library" ? (openPlaylistId ? "" : "Library") : "Search"}</h1>
        {!openPlaylistId && (
          <div className="flex items-center gap-2">
            {activeTab === "home" && (
              <>
                <button onClick={() => setShowStats(true)} className="press p-2 rounded-full" style={{ background: palette.surface }}><TrendingUp size={16} /></button>
                <button onClick={() => { setShowSettings(true); refreshStorageEstimate(); }} className="glass-pill press press-3d p-2 rounded-full" style={{ background: palette.surface }}><Settings size={16} /></button>
              </>
            )}
            <button onClick={() => fileInputRef.current?.click()} className="glass-pill press press-3d p-2 rounded-full" style={{ background: palette.surface }}><Upload size={17} /></button>
          </div>
        )}
        {openPlaylistId && (
          <div className="flex items-center gap-3">
            <button onClick={() => sharePlaylistCard(activePlaylist)} className="press p-1.5"><Share2 size={18} /></button>
            <button onClick={() => setOpenPlaylistId(null)} className="press flex items-center gap-1 text-sm font-medium" style={{ color: "#FA2D48" }}><ArrowLeft size={18} /> Library</button>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="audio/*" multiple onChange={onFileInputChange} className="hidden" />
        <input ref={folderInputRef} type="file" accept="audio/*" multiple webkitdirectory="" directory="" onChange={(e) => { if (e.target.files?.length) importFolder(e.target.files); e.target.value = ""; }} className="hidden" />
        <input ref={backupInputRef} type="file" accept="application/json" onChange={(e) => { if (e.target.files?.[0]) importPlaylistsFile(e.target.files[0]); e.target.value = ""; }} className="hidden" />
      </header>

      <main className="flex-1 overflow-y-auto px-4" style={{ paddingBottom: currentTrack ? 148 : 78, background: palette.bg, color: palette.text }} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {activeTab === "home" && (
          <div className="flex flex-col gap-6 pt-1">
            {library.length === 0 ? (
              <EmptyState dragOver={dragOver} message="Import some tracks to get started. Drag files anywhere, or tap the upload icon above." />
            ) : (
              <>
                <button onClick={shuffleAll} className="press glass-pill press-3d w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold" style={{ color: palette.text }}>
                  <Shuffle size={16} color={accent} /> Shuffle All ({library.length} songs)
                </button>
                <HomeRow title="Recently Added" tracks={recentlyAdded} onPlay={(i) => playFrom(recentlyAdded, i, "Recently Added")} />
                {likedTracks.length > 0 && <HomeRow title="Favorites" icon={<Heart size={14} />} tracks={likedTracks} onPlay={(i) => playFrom(likedTracks, i, "Favorites")} />}
                {recentlyPlayedTracks.length > 0 && <HomeRow title="Recently Played" icon={<Clock size={14} />} tracks={recentlyPlayedTracks} onPlay={(i) => playFrom(recentlyPlayedTracks, i, "Recently Played")} />}
                {mostPlayed.length > 0 && <HomeRow title="Most Played" icon={<TrendingUp size={14} />} tracks={mostPlayed} onPlay={(i) => playFrom(mostPlayed, i, "Most Played")} />}
                {playlists.length > 0 && (
                  <div>
                    <div className="text-lg font-bold mb-3">Your Playlists</div>
                    <div className="hscroll pb-2">
                      {playlists.map((p) => (
                        <button key={p.id} onClick={() => { setActiveTab("library"); setOpenPlaylistId(p.id); }} className="press shrink-0 w-32 text-left">
                          <div className="w-32 h-32 rounded-xl flex items-center justify-center mb-2 glass-tile" style={{ background: palette.surface }}><ListMusic size={26} color={palette.accent} /></div>
                          <div className="text-sm font-medium truncate">{p.name}</div>
                          <div className="text-xs" style={{ color: "#98989D" }}>{p.trackIds.length} songs</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "library" && !openPlaylistId && (
          <div>
            <div className="flex items-center gap-2 mb-3 pt-1">
              <button onClick={() => setNewPlaylistSheet(true)} className="press flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: "rgba(250,45,72,0.15)", color: "#FA2D48" }}><Plus size={14} /> Playlist</button>
              <button onClick={() => { setSelectMode((s) => !s); setSelectedIds([]); }} className="press px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: selectMode ? palette.accent : palette.surface2, color: selectMode ? "#fff" : palette.subtext }}>{selectMode ? "Done" : "Select"}</button>
              <div className="flex-1" />
              {!selectMode && (<>
                <button onClick={() => setLibraryView((v) => (v === "list" ? "grid" : "list"))} className="glass-pill press press-3d p-2 rounded-full" style={{ background: palette.surface2, color: palette.text }}>{libraryView === "list" ? <LayoutGrid size={15} /> : <ListIcon size={15} />}</button>
                <div className="relative">
                  <button onClick={() => setShowSortMenu((s) => !s)} className="glass-pill press press-3d p-2 rounded-full" style={{ background: palette.surface2, color: palette.text }}><ArrowUpDown size={15} /></button>
                  {showSortMenu && (
                    <div className="absolute right-0 top-10 rounded-xl py-1 w-40 fade-in" style={{ background: palette.surface2, zIndex: 30 }}>
                      {[["recent", "Recently Added"], ["name", "Name"], ["duration", "Duration"]].map(([k, l]) => (<button key={k} onClick={() => { setLibrarySort(k); setShowSortMenu(false); }} className="block w-full text-left px-4 py-2 text-xs" style={{ color: librarySort === k ? palette.accent : palette.text }}>{l}</button>))}
                    </div>
                  )}
                </div>
              </>)}
            </div>

            {!selectMode && (
              <div className="hscroll pb-3">
                <button onClick={() => setActiveTagFilter(null)} className="press px-3 py-1.5 rounded-full text-xs font-medium shrink-0" style={{ background: !activeTagFilter ? palette.accent : palette.surface2, color: !activeTagFilter ? "#fff" : palette.subtext }}>All</button>
                {MOOD_TAGS.map((tag) => (
                  <button key={tag} onClick={() => setActiveTagFilter(activeTagFilter === tag ? null : tag)} className="press px-3 py-1.5 rounded-full text-xs font-medium shrink-0" style={{ background: activeTagFilter === tag ? palette.accent : palette.surface2, color: activeTagFilter === tag ? "#fff" : palette.subtext }}>{tag}</button>
                ))}
              </div>
            )}

            {!selectMode && playlists.length > 0 && (
              <div className="hscroll pb-3">
                {playlists.map((p) => (
                  <button key={p.id} onClick={() => setOpenPlaylistId(p.id)} className="press shrink-0 w-28 text-left">
                    <div className="w-28 h-28 rounded-xl flex items-center justify-center mb-1.5 glass-tile" style={{ background: palette.surface }}><ListMusic size={22} color={palette.accent} /></div>
                    <div className="text-xs font-medium truncate">{p.name}</div>
                  </button>
                ))}
              </div>
            )}

            {sortedLibrary.length === 0 ? (
              <EmptyState dragOver={dragOver} message="Drag audio files anywhere, or tap the upload icon above. Nothing is re-encoded — original quality stays intact." />
            ) : libraryView === "grid" && !selectMode ? (
              <div className="grid grid-cols-3 gap-3 mt-1">
                {sortedLibrary.map((t, i) => (
                  <button key={t.id} onClick={() => playFrom(sortedLibrary, i, "Library")} className="press text-left">
                    <ArtBox track={t} className="w-full aspect-square rounded-lg mb-1.5" />
                    <div className="text-xs truncate">{t.name}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-1">
                {sortedLibrary.map((t, i) => (
                  <TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying} palette={palette}
                    selectMode={selectMode} selected={selectedIds.includes(t.id)} onToggleSelect={() => toggleSelect(t.id)}
                    liked={likedIds.includes(t.id)}
                    onTap={() => playFrom(sortedLibrary, i, "Library")} onMenu={() => openContext(t.id, "library")} onSwipeDelete={() => deleteFromLibrary(t.id)} />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "library" && openPlaylistId && (
          <div className="pt-1">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-20 h-20 rounded-xl flex items-center justify-center shrink-0 glass-tile" style={{ background: palette.surface }}><ListMusic size={30} color={palette.accent} /></div>
              <div><div className="text-xl font-extrabold">{activePlaylist?.name}</div><div className="text-xs" style={{ color: "#98989D" }}>{playlistTracks.length} songs</div></div>
              <button onClick={() => deletePlaylist(openPlaylistId)} className="press ml-auto p-2" style={{ color: "#7A3A22" }}><Trash2 size={17} /></button>
            </div>
            {playlistTracks.length === 0 ? (
              <EmptyState dragOver={false} message="This playlist is empty. Go to a track's ⋯ menu in Library to add it here." />
            ) : (
              playlistTracks.map((t, i) => (
                <TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying} palette={palette} liked={likedIds.includes(t.id)}
                  onTap={() => playFrom(playlistTracks, i, activePlaylist.name)} onMenu={() => openContext(t.id, "playlist", openPlaylistId)} onSwipeDelete={() => removeFromPlaylist(openPlaylistId, t.id)} />
              ))
            )}
          </div>
        )}

        {activeTab === "search" && (
          <div className="pt-1">
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl mb-4" style={{ background: palette.surface }}>
              <Search size={15} color={palette.subtext} />
              <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Artists, Songs, Playlists" className="bg-transparent outline-none text-sm flex-1" style={{ color: palette.text }} />
              {searchQuery && <button onClick={() => setSearchQuery("")}><X size={15} color={palette.subtext} /></button>}
            </div>
            {!q ? (<div className="text-sm text-center py-16" style={{ color: palette.subtext }}>Search your library and playlists</div>) : (
              <>
                {searchLibraryResults.length === 0 && searchPlaylistResults.length === 0 && <div className="text-sm text-center py-16" style={{ color: palette.subtext }}>No results for "{searchQuery}"</div>}
                {searchLibraryResults.length > 0 && (
                  <div className="mb-5">
                    <div className="text-xs font-semibold tracking-wide mb-1" style={{ color: "#98989D" }}>LIBRARY</div>
                    {searchLibraryResults.map((t, i) => (<TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying} palette={palette} liked={likedIds.includes(t.id)} onTap={() => playFrom(searchLibraryResults, i, "Search")} onMenu={() => openContext(t.id, "library")} />))}
                  </div>
                )}
                {searchPlaylistResults.map(({ playlist, tracks }) => (
                  <div key={playlist.id} className="mb-5">
                    <div className="text-xs font-semibold tracking-wide mb-1" style={{ color: "#98989D" }}>{playlist.name.toUpperCase()}</div>
                    {tracks.map((t, i) => (<TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying} palette={palette} liked={likedIds.includes(t.id)} onTap={() => playFrom(tracks, i, playlist.name)} onMenu={() => openContext(t.id, "playlist", playlist.id)} />))}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </main>

      {currentTrack && !nowPlayingOpen && !selectMode && (
        <div onClick={() => setNowPlayingOpen(true)} className={`glass press press-3d absolute left-2 right-2 flex items-center gap-3 px-3 rounded-2xl fade-in ${theme === "light" ? "glass-light" : ""}`} style={{ bottom: 66, height: 60, zIndex: 20, border: theme === "light" ? undefined : "1px solid rgba(255,255,255,0.16)", boxShadow: "0 4px 14px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.18)" }}>
          <ArtBox track={currentTrack} className="w-9 h-9 rounded-lg shrink-0" />
          <div className="flex-1 min-w-0 text-left"><div className="text-sm font-medium truncate">{currentTrack.name}</div></div>
          {isPlaying && <div className="flex items-end gap-0.5 h-4 shrink-0"><div className="eq-bar" style={{ animationDelay: "0s" }} /><div className="eq-bar" style={{ animationDelay: "0.2s" }} /><div className="eq-bar" style={{ animationDelay: "0.4s" }} /></div>}
          <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="press p-1.5 shrink-0">{isPlaying ? <Pause size={22} fill="#FFFFFF" /> : <Play size={22} fill="#FFFFFF" style={{ marginLeft: 2 }} />}</button>
          <button onClick={(e) => { e.stopPropagation(); stepTrack(1); }} className="press p-1.5 shrink-0"><SkipForward size={20} fill="#FFFFFF" /></button>
        </div>
      )}

      {selectMode && (
        <div className={`glass absolute left-2 right-2 flex items-center gap-2 px-3 rounded-2xl fade-in ${theme === "light" ? "glass-light" : ""}`} style={{ bottom: 66, height: 60, zIndex: 20, border: theme === "light" ? undefined : "1px solid rgba(255,255,255,0.16)" }}>
          <button onClick={clearSelection} className="press p-2"><X size={20} /></button>
          <span className="text-sm font-medium flex-1">{selectedIds.length} selected</span>
          <button onClick={bulkPlay} disabled={!selectedIds.length} className="press p-2" style={{ opacity: selectedIds.length ? 1 : 0.35 }}><Play size={20} fill="#fff" /></button>
          <button onClick={() => setBulkAddSheetOpen(true)} disabled={!selectedIds.length} className="press p-2" style={{ opacity: selectedIds.length ? 1 : 0.35 }}><ListPlus size={20} /></button>
          <button onClick={bulkDelete} disabled={!selectedIds.length} className="press p-2" style={{ color: "#FF453A", opacity: selectedIds.length ? 1 : 0.35 }}><Trash2 size={20} /></button>
        </div>
      )}

      <nav className={`glass absolute left-0 right-0 bottom-0 flex items-stretch ${theme === "light" ? "glass-light" : ""}`} style={{ height: 66, zIndex: 21, border: "none", borderTop: `1px solid ${theme === "light" ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.1)"}`, boxShadow: "none" }}>
        {[["home", "Home", <Home size={22} />], ["library", "Library", <LibraryIcon size={22} />], ["search", "Search", <Search size={22} />]].map(([key, label, icon]) => (
          <button key={key} onClick={() => { setActiveTab(key); if (key !== "library") setOpenPlaylistId(null); clearSelection(); }} className="press flex-1 flex flex-col items-center justify-center gap-1" style={{ color: activeTab === key ? "#FA2D48" : "#98989D" }}>{icon}<span className="text-[10px] font-medium">{label}</span></button>
        ))}
      </nav>

      {nowPlayingOpen && currentTrack && (
        <div className="sheet-enter absolute inset-0 flex flex-col overflow-hidden" style={{ zIndex: 60, transform: `translateY(${dragY}px)`, transition: dragging ? "none" : `transform 0.3s ${SPRING}` }}>
          <div className="absolute inset-0" style={{ background: "#0A0A0A" }} />
          <div ref={bgGlowRef} className="absolute" style={{ top: "-20%", left: "-20%", width: "140%", height: "70%", background: themeColor ? `radial-gradient(circle, rgb(${themeColor.r},${themeColor.g},${themeColor.b}), transparent 70%)` : artGradient(currentTrack.name), filter: "blur(90px)", opacity: 0.55, transition: "transform 0.08s linear, opacity 0.08s linear" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.6) 55%, #0A0A0A 90%)" }} />

          <div className="relative flex flex-col h-full" onTouchStart={onSheetTouchStart} onTouchMove={onSheetTouchMove} onTouchEnd={onSheetTouchEnd}>
            <div className="flex flex-col items-center pt-2 pb-1 shrink-0"><div className="w-9 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.35)" }} /></div>
            <div className="flex items-center justify-between px-5 shrink-0" style={{ height: 44 }}>
              <button onClick={() => setNowPlayingOpen(false)} className="press p-1"><ChevronDown size={22} /></button>
              <div className="text-center"><div className="text-[10px] tracking-wider" style={{ color: "#98989D" }}>PLAYING FROM</div><div className="text-xs font-semibold">{queueSource}</div></div>
              <div className="flex items-center gap-3">
                <button onClick={() => setVinylMode((v) => !v)} className="press p-1"><Disc3 size={19} color={vinylMode ? accent : "#FFFFFF"} /></button>
                {vinylMode && <button onClick={() => setCrackleEnabled((c) => !c)} className="press p-1" title="Vinyl crackle"><Waves size={18} color={crackleEnabled ? accent : "#FFFFFF"} /></button>}
                <button onClick={startFloatingPlayer} className="press p-1"><PictureInPicture2 size={17} /></button>
                <button onClick={() => toggleLike(currentTrack.id)} className="press p-1"><Heart size={19} color={likedIds.includes(currentTrack.id) ? accent : "#FFFFFF"} fill={likedIds.includes(currentTrack.id) ? accent : "none"} /></button>
                <button onClick={() => setInfoSheetTrackId(currentTrack.id)} className="press p-1"><Info size={19} /></button>
              </div>
            </div>

            {npView === "player" && (
              <div className="np-player-body flex-1 flex flex-col items-center justify-center px-8 gap-6 overflow-y-auto">
                <div className="np-art w-full max-w-xs aspect-square rounded-2xl overflow-hidden shadow-2xl" onTouchStart={vinylMode ? undefined : onArtTouchStart} onTouchMove={vinylMode ? undefined : onArtTouchMove} onTouchEnd={vinylMode ? undefined : onArtTouchEnd}
                  style={{ transform: `translateX(${artSwipeX}px)`, transition: artSwipeX === 0 ? `transform 0.25s ${SPRING}` : "none" }}>
                  {vinylMode ? (() => {
                    const vc = VINYL_COLORS[vinylColor] || VINYL_COLORS.classic;
                    const vb = VINYL_BACKDROPS[vinylBackdrop] || VINYL_BACKDROPS.studio;
                    const progress = duration > 0 ? currentTime / duration : 0;
                    const restAngle = -18, engagedBase = 8, engagedEnd = 32;
                    const engagedAngle = engagedBase + progress * (engagedEnd - engagedBase);
                    const displayAngle = armDragging && armAngleOverride != null ? armAngleOverride : (isPlaying ? engagedAngle : restAngle);
                    const spinDuration = RPM_SPEEDS[vinylRPM] || RPM_SPEEDS[33];
                    const labelPathId = `vinylLabelPath-${currentTrack.id}`;
                    const glowColor = themeColor ? `rgba(${themeColor.r},${themeColor.g},${themeColor.b},0.45)` : `hsla(${artHue(currentTrack.name)}, 70%, 55%, 0.45)`;

                    const onArmTouchStart = (e) => {
                      e.stopPropagation();
                      armDragRef.current = { startX: e.touches[0].clientX, baseline: isPlaying ? 1 : 0, engagement: isPlaying ? 1 : 0 };
                      setArmDragging(true);
                      playNeedleClick(isPlaying ? "up" : "down");
                    };
                    const onArmTouchMove = (e) => {
                      e.stopPropagation();
                      if (!armDragRef.current) return;
                      const dx = e.touches[0].clientX - armDragRef.current.startX;
                      const engagement = Math.max(0, Math.min(1, armDragRef.current.baseline + dx / 80));
                      armDragRef.current.engagement = engagement;
                      setArmAngleOverride(restAngle + engagement * (engagedAngle - restAngle));
                    };
                    const onArmTouchEnd = (e) => {
                      e.stopPropagation();
                      const engagement = armDragRef.current?.engagement ?? (isPlaying ? 1 : 0);
                      if (engagement > 0.5) { if (!isPlaying) togglePlay(); }
                      else { if (isPlaying) togglePlay(); }
                      armDragRef.current = null;
                      setArmDragging(false);
                      setArmAngleOverride(null);
                    };

                    return (
                      <div className="w-full h-full flex items-center justify-center relative" style={{ background: vb.css }}>
                        {/* Reactive glow — the record breathes with the music */}
                        <div ref={vinylPulseRef} className="absolute rounded-full pointer-events-none" style={{ width: "94%", height: "94%", background: `radial-gradient(circle, ${glowColor}, transparent 72%)`, opacity: 0, filter: "blur(18px)", transition: "opacity 0.15s linear" }} />

                        <div
                          className="rounded-full relative"
                          onTouchStart={onDiscTouchStart} onTouchMove={onDiscTouchMove} onTouchEnd={onDiscTouchEnd}
                          style={{
                            width: "88%", height: "88%",
                            background: `repeating-radial-gradient(circle, ${vc.base} 0px, ${vc.base} 2px, ${vc.groove} 3px, ${vc.base} 4px)`,
                            animation: !scratchDragging && isPlaying ? `spin ${spinDuration}s linear infinite` : "none",
                            transform: scratchDragging ? `rotate(${scratchAngle}deg)` : undefined,
                            boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
                            cursor: "grab",
                            touchAction: "none",
                          }}
                        >
                          {/* Curved run-out text — a bit of vinyl label typography */}
                          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
                            <defs>
                              <path id={labelPathId} d="M 50,50 m -33,0 a 33,33 0 1,1 66,0 a 33,33 0 1,1 -66,0" />
                            </defs>
                            <text fill="rgba(255,255,255,0.32)" fontSize="3.1" letterSpacing="2">
                              <textPath href={`#${labelPathId}`} startOffset="0%">
                                {(currentTrack.name || "SPOOL").toUpperCase()} • SPOOL VINYL •{" "}
                              </textPath>
                            </text>
                          </svg>

                          <div className="absolute rounded-full overflow-hidden" style={{ width: "38%", height: "38%", top: "31%", left: "31%", boxShadow: `0 0 0 3px #0a0a0a, 0 0 0 4px ${vc.groove}` }}>
                            <ArtBox track={currentTrack} className="w-full h-full flex items-center justify-center">
                              {!currentTrack.artUrl && <Disc3 size={30} color="rgba(255,255,255,0.5)" />}
                            </ArtBox>
                          </div>
                          <div className="absolute rounded-full" style={{ width: 10, height: 10, top: "50%", left: "50%", transform: "translate(-50%,-50%)", background: "#0a0a0a" }} />

                          {/* Specular sheen sweep — a soft light glint that rides the disc */}
                          {vinylShine && (
                            <div className="absolute inset-0 rounded-full pointer-events-none" style={{
                              background: "conic-gradient(from 0deg, transparent 0%, rgba(255,255,255,0.24) 6%, transparent 16%, transparent 82%, rgba(255,255,255,0.12) 92%, transparent 100%)",
                              animation: "vinylShine 7s linear infinite",
                              mixBlendMode: "screen",
                            }} />
                          )}
                        </div>

                        {/* Interactive tonearm — drag it onto the record to play, off to pause */}
                        <div className="absolute" style={{ top: "2%", right: "4%", width: "46%", height: "46%", transformOrigin: "88% 12%", transform: `rotate(${displayAngle}deg)`, transition: armDragging ? "none" : `transform 0.4s ${SPRING}`, zIndex: 5 }}>
                          <div style={{ position: "absolute", top: "8%", right: "8%", width: 22, height: 22, borderRadius: "50%", background: "#3a3a3d", boxShadow: "0 2px 6px rgba(0,0,0,0.5)" }} />
                          <div style={{ position: "absolute", top: "16%", right: "16%", width: 5, height: "72%", background: "linear-gradient(#5a5a5d, #3a3a3d)", borderRadius: 3, transformOrigin: "top center" }} />
                          <div
                            onTouchStart={onArmTouchStart} onTouchMove={onArmTouchMove} onTouchEnd={onArmTouchEnd} onClick={(e) => e.stopPropagation()}
                            style={{ position: "absolute", bottom: "6%", left: "2%", width: 20, height: 20, borderRadius: "50%", background: "#c9a227", boxShadow: "0 2px 6px rgba(0,0,0,0.5)", cursor: "grab" }}
                          />
                        </div>

                        {/* Floating dust motes for ambience */}
                        {vinylDust && (
                          <div className="absolute inset-0 overflow-hidden rounded-2xl pointer-events-none" style={{ zIndex: 3 }}>
                            {dustMotes.map((d) => (
                              <div key={d.id} style={{
                                position: "absolute", left: `${d.left}%`, top: `${d.top}%`,
                                width: d.size, height: d.size, borderRadius: "50%",
                                background: "rgba(255,255,255,0.55)",
                                animation: `dustFloat ${d.dur}s ease-in-out ${d.delay}s infinite`,
                                "--drift": `${d.drift}px`,
                              }} />
                            ))}
                          </div>
                        )}

                        <style>{`
                          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                          @keyframes vinylShine { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                          @keyframes dustFloat { 0%, 100% { transform: translate(0, 0); opacity: 0.12; } 50% { transform: translate(var(--drift), -16px); opacity: 0.6; } }
                          .vinyl-swatch-row::-webkit-scrollbar { display: none; }
                        `}</style>

                        {/* Quick vinyl color + backdrop swatches */}
                        <div className="vinyl-swatch-row absolute left-0 right-0 flex items-center justify-center gap-1.5 overflow-x-auto px-3" style={{ bottom: 8, scrollbarWidth: "none" }}>
                          {Object.entries(VINYL_COLORS).map(([key, v]) => (
                            <button key={key} onClick={(e) => { e.stopPropagation(); setVinylColor(key); }} className="press rounded-full shrink-0" style={{ width: 16, height: 16, background: v.swatch, border: vinylColor === key ? "2px solid #fff" : "2px solid rgba(255,255,255,0.3)" }} />
                          ))}
                          <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.25)", margin: "0 2px", flexShrink: 0 }} />
                          {Object.entries(VINYL_BACKDROPS).map(([key, v]) => (
                            <button key={key} onClick={(e) => { e.stopPropagation(); setVinylBackdrop(key); }} className="press rounded-full shrink-0" style={{ width: 16, height: 16, background: v.css, border: vinylBackdrop === key ? "2px solid #fff" : "2px solid rgba(255,255,255,0.3)" }} />
                          ))}
                          <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.25)", margin: "0 2px", flexShrink: 0 }} />
                          <button onClick={(e) => { e.stopPropagation(); setShowVinylPanel((s) => !s); setShowEq(false); setShowSleep(false); }} className="press rounded-full shrink-0 flex items-center justify-center" style={{ width: 18, height: 18, background: showVinylPanel ? accent : "rgba(255,255,255,0.15)" }}>
                            <Settings size={11} color="#fff" />
                          </button>
                        </div>
                      </div>
                    );
                  })() : (
                    <ArtBox track={currentTrack} className="w-full h-full flex items-center justify-center">
                      {!currentTrack.artUrl && <Disc3 size={70} color="rgba(255,255,255,0.55)" className={isPlaying ? "animate-spin" : ""} style={{ animationDuration: "4s" }} />}
                    </ArtBox>
                  )}
                </div>

                <div className="np-controls-col flex flex-col items-center gap-6 w-full">
                <div className="text-center w-full">
                  <div className="text-xl font-bold truncate">{currentTrack.name}</div>
                  <div className="text-xs mt-1" style={{ color: "#98989D" }}>{currentTrack.ext} · lossless passthrough</div>
                </div>

                <div className="w-full flex items-center gap-3">
                  <span className="text-xs w-9 text-right" style={{ color: "#98989D" }}>{fmtTime(currentTime)}</span>
                  <div ref={waveWrapRef} className="flex-1 h-11"><canvas ref={waveCanvasRef} height={44} onClick={onWaveClick} className="w-full h-full" /></div>
                  <span className="text-xs w-9" style={{ color: "#98989D" }}>{fmtTime(duration)}</span>
                </div>

                <div className="flex items-center gap-6">
                  <button onClick={() => setShuffle((s) => !s)} className="press" style={{ color: shuffle ? accent : "#98989D" }}><Shuffle size={19} /></button>
                  <button onClick={() => stepTrack(-1)} className="press"><SkipBack size={28} fill="#FFFFFF" /></button>
                  <div className="relative">
                    <div className="absolute rounded-full" style={{ inset: -10, background: accent, filter: "blur(18px)", opacity: isPlaying ? 0.55 : 0.25, transition: "opacity 0.4s" }} />
                    <button onClick={togglePlay} className="press press-3d shine-sweep relative w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(155deg, #FFFFFF, #E4E4E6)", boxShadow: "0 8px 20px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.9), inset 0 -3px 6px rgba(0,0,0,0.12)" }}>{isPlaying ? <Pause size={26} color="#000000" fill="#000000" /> : <Play size={26} color="#000000" fill="#000000" style={{ marginLeft: 3 }} />}</button>
                  </div>
                  <button onClick={() => stepTrack(1)} className="press"><SkipForward size={28} fill="#FFFFFF" /></button>
                  <button onClick={cycleRepeat} className="press" style={{ color: repeatMode !== "off" ? accent : "#98989D" }}>{repeatMode === "one" ? <Repeat1 size={19} /> : <Repeat size={19} />}</button>
                </div>

                <canvas ref={vuCanvasRef} width={140} height={26} />

                <div className="w-full flex items-center gap-4">
                  <button onClick={() => setMuted((m) => !m)} style={{ color: "#98989D" }}>{muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
                  <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={onVolumeChange} className="flex-1" />
                </div>

                <div className="flex items-center gap-6 pb-2">
                  <button onClick={() => setNpView("lyrics")} className="press flex flex-col items-center gap-1" style={{ color: "#98989D" }}><Mic2 size={18} /><span className="text-[10px]">Lyrics</span></button>
                  <button onClick={handleLoopTap} className="press flex flex-col items-center gap-1" style={{ color: loopA != null ? accent : "#98989D" }}><Repeat size={18} /><span className="text-[10px]">{loopB != null ? "Looping" : loopA != null ? "Set End" : "A-B Loop"}</span></button>
                  <button onClick={() => { setShowSleep((s) => !s); setShowEq(false); setShowVinylPanel(false); setShowSpeed(false); }} className="press flex flex-col items-center gap-1" style={{ color: sleepEndsAt ? accent : "#98989D" }}><Moon size={18} /><span className="text-[10px]">{sleepRemaining != null ? fmtTime(sleepRemaining / 1000) : "Sleep"}</span></button>
                  <button onClick={() => { setShowEq((s) => !s); setShowSleep(false); setShowVinylPanel(false); setShowSpeed(false); }} className="press flex flex-col items-center gap-1" style={{ color: showEq || eqBands.bass || eqBands.mid || eqBands.treble ? accent : "#98989D" }}><SlidersHorizontal size={18} /><span className="text-[10px]">EQ</span></button>
                  <button onClick={() => { setShowSpeed((s) => !s); setShowEq(false); setShowSleep(false); setShowVinylPanel(false); }} className="press flex flex-col items-center gap-1" style={{ color: showSpeed || playbackRate !== 1 ? accent : "#98989D" }}><Gauge size={18} /><span className="text-[10px]">{playbackRate}x</span></button>
                  {vinylMode && <button onClick={() => { setShowVinylPanel((s) => !s); setShowEq(false); setShowSleep(false); setShowSpeed(false); }} className="press flex flex-col items-center gap-1" style={{ color: showVinylPanel ? accent : "#98989D" }}><Disc3 size={18} /><span className="text-[10px]">Vinyl</span></button>}
                  <button onClick={() => setNpView("queue")} className="press flex flex-col items-center gap-1" style={{ color: "#98989D" }}><ListMusic size={18} /><span className="text-[10px]">Up Next</span></button>
                </div>

                {showSpeed && (
                  <div className="flex flex-col items-center gap-3 px-6 py-4 rounded-xl w-full max-w-xs fade-in" style={{ background: "rgba(28,28,30,0.9)" }}>
                    <span className="text-xs tracking-widest" style={{ color: "#98989D" }}>PLAYBACK SPEED</span>
                    <div className="flex items-center gap-2 flex-wrap justify-center">
                      {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                        <button key={r} onClick={() => setPlaybackRate(r)} className="press px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: playbackRate === r ? accent : "rgba(255,255,255,0.1)", color: playbackRate === r ? "#fff" : "#98989D" }}>{r}x</button>
                      ))}
                    </div>
                  </div>
                )}

                {showVinylPanel && vinylMode && (
                  <div className="flex flex-col items-center gap-3 px-6 py-4 rounded-xl w-full max-w-xs fade-in" style={{ background: "rgba(28,28,30,0.9)" }}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs tracking-widest" style={{ color: "#98989D" }}>SPEED</span>
                      {[33, 45].map((r) => (
                        <button key={r} onClick={() => setVinylRPM(r)} className="press px-3 py-1 rounded-full text-xs" style={{ background: vinylRPM === r ? accent : "rgba(255,255,255,0.1)", color: vinylRPM === r ? "#fff" : "#98989D" }}>{r} RPM</button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-center">
                      <button onClick={() => setCrackleEnabled((v) => !v)} className="press flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs" style={{ background: crackleEnabled ? accent : "rgba(255,255,255,0.1)", color: crackleEnabled ? "#fff" : "#98989D" }}><Waves size={14} />Crackle</button>
                      <button onClick={() => setVinylShine((v) => !v)} className="press flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs" style={{ background: vinylShine ? accent : "rgba(255,255,255,0.1)", color: vinylShine ? "#fff" : "#98989D" }}><Sparkles size={14} />Shine</button>
                      <button onClick={() => setVinylDust((v) => !v)} className="press flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs" style={{ background: vinylDust ? accent : "rgba(255,255,255,0.1)", color: vinylDust ? "#fff" : "#98989D" }}><Wind size={14} />Dust</button>
                      <button onClick={() => setVinylReactive((v) => !v)} className="press flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs" style={{ background: vinylReactive ? accent : "rgba(255,255,255,0.1)", color: vinylReactive ? "#fff" : "#98989D" }}><Gauge size={14} />Pulse</button>
                    </div>
                    <span className="text-[10px] text-center" style={{ color: "#6E6E73" }}>Tip: grab the record and drag to scratch through the track</span>
                  </div>
                )}

                {showEq && (
                  <div className="flex flex-col items-center gap-3 px-6 py-4 rounded-xl" style={{ background: "rgba(28,28,30,0.9)" }}>
                    <div className="flex gap-2">
                      {Object.keys(EQ_PRESETS).map((name) => (
                        <button key={name} onClick={() => { setEqBands(EQ_PRESETS[name]); setEqPreset(name); }} className="press px-3 py-1 rounded-full text-xs" style={{ background: eqPreset === name ? accent : "rgba(255,255,255,0.1)", color: eqPreset === name ? "#fff" : "#98989D" }}>{name}</button>
                      ))}
                    </div>
                    <div className="flex items-end gap-6 pt-1">
                      {[["bass", "BASS"], ["mid", "MID"], ["treble", "TREB"]].map(([key, label]) => (
                        <div key={key} className="flex flex-col items-center gap-2">
                          <span className="text-xs" style={{ color: accent }}>{eqBands[key] > 0 ? `+${eqBands[key]}` : eqBands[key]}</span>
                          <input type="range" className="vert" min={-12} max={12} step={1} value={eqBands[key]} onChange={(e) => { setEqBands((b) => ({ ...b, [key]: Number(e.target.value) })); setEqPreset("Custom"); }} />
                          <span className="text-xs tracking-widest" style={{ color: "#98989D" }}>{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {showSleep && (
                  <div className="rounded-xl py-1 w-40" style={{ background: "rgba(28,28,30,0.95)" }}>
                    {[15, 30, 45, 60].map((m) => (<button key={m} onClick={() => setSleepMinutes(m)} className="block w-full text-left px-4 py-2 text-xs">{m} minutes</button>))}
                    <button onClick={() => setSleepMinutes(0)} className="block w-full text-left px-4 py-2 text-xs" style={{ color: "#FF453A" }}>Turn off</button>
                  </div>
                )}
              </div>
              </div>
            )}

            {npView === "queue" && (
              <div className="flex-1 overflow-y-auto px-2">
                <div className="flex items-center justify-between px-3 py-2">
                  <button onClick={() => setNpView("player")} className="press flex items-center gap-1 text-sm font-medium"><ChevronDown size={17} /> Back</button>
                  <span className="text-xs tracking-widest" style={{ color: "#98989D" }}>UP NEXT · drag to reorder</span>
                  <button onClick={() => { setNewPlaylistFromQueue(true); setNewPlaylistSheet(true); }} className="press text-xs font-medium" style={{ color: "#FA2D48" }}>Save</button>
                </div>
                {queue.map((id, i) => {
                  const t = library.find((tt) => tt.id === id);
                  if (!t) return null;
                  return (
                    <div key={i} draggable onDragStart={() => setRowDragIdx(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { reorderQueue(rowDragIdx, i); setRowDragIdx(null); }}
                      className="flex items-center gap-3 px-3 py-2.5" style={{ background: i === queueIndex ? "rgba(250,45,72,0.12)" : "transparent", borderRadius: 10 }}>
                      <GripVertical size={14} color="#5A5A5C" />
                      <ArtBox track={t} className="w-9 h-9 rounded-md shrink-0" />
                      <div className="flex-1 min-w-0"><div className="text-sm truncate" style={{ color: i === queueIndex ? accent : "#FFFFFF" }}>{t.name}</div><div className="text-xs" style={{ color: "#98989D" }}>{t.ext}</div></div>
                      {i !== queueIndex && <button onClick={() => removeFromQueue(i)} className="press p-1.5" style={{ color: "#7A3A22" }}><X size={15} /></button>}
                    </div>
                  );
                })}
              </div>
            )}

            {npView === "lyrics" && <LyricsPanel track={currentTrack} text={lyricsMap[currentTrack.id] || ""} onSave={(text) => setLyricsMap((prev) => ({ ...prev, [currentTrack.id]: text }))} onBack={() => setNpView("player")} />}
          </div>
        </div>
      )}

      {contextTrackId && (
        <BottomSheetBackdrop bg={sheetBg} onClose={closeContext}>
          <SheetHandle />
          <div className="px-5 pb-1 text-sm font-semibold truncate">{library.find((t) => t.id === contextTrackId)?.name}</div>
          <SheetAction icon={<CornerDownRight size={17} />} label="Play Next" onClick={() => { playNext(contextTrackId); closeContext(); }} />
          <SheetAction icon={<ListPlus size={17} />} label="Play Later" onClick={() => { playLater(contextTrackId); closeContext(); }} />
          <SheetAction icon={<Heart size={17} fill={likedIds.includes(contextTrackId) ? "#FA2D48" : "none"} />} label={likedIds.includes(contextTrackId) ? "Unlike" : "Like"} onClick={() => { toggleLike(contextTrackId); closeContext(); }} />
          <SheetAction icon={<Plus size={17} />} label="Add to Playlist…" onClick={() => { const id = contextTrackId; closeContext(); setAddSheetTrackId(id); }} />
          <SheetAction icon={<Info size={17} />} label="Song Info" onClick={() => { const id = contextTrackId; closeContext(); setInfoSheetTrackId(id); }} />
          <SheetAction icon={<Tag size={17} />} label="Mood Tags…" onClick={() => { const id = contextTrackId; closeContext(); setTagSheetTrackId(id); }} />
          <SheetAction icon={<CornerDownRight size={17} style={{ transform: "scaleX(-1)" }} />} label="Rename…" onClick={() => { const id = contextTrackId; const t = library.find((tt) => tt.id === id); closeContext(); setRenameDraft(t?.name || ""); setRenameTrackId(id); }} />
          {contextInfo?.mode === "playlist" ? (
            <SheetAction icon={<Trash2 size={17} />} label="Remove from Playlist" danger onClick={() => { removeFromPlaylist(contextInfo.playlistId, contextTrackId); closeContext(); }} />
          ) : (
            <SheetAction icon={<Trash2 size={17} />} label="Delete from Library" danger onClick={() => { deleteFromLibrary(contextTrackId); closeContext(); }} />
          )}
        </BottomSheetBackdrop>
      )}

      {addSheetTrackId && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => setAddSheetTrackId(null)}>
          <SheetHandle />
          <div className="px-5 pb-2 text-sm font-semibold">Add to Playlist</div>
          <div className="max-h-64 overflow-y-auto">
            {playlists.length === 0 ? (<div className="px-5 py-4 text-xs" style={{ color: "#98989D" }}>No playlists yet. Create one from the Library tab.</div>) : (
              playlists.map((p) => (<SheetAction key={p.id} icon={<ListMusic size={17} color="#FA2D48" />} label={p.name} sub={`${p.trackIds.length} songs`} onClick={() => addToPlaylist(p.id, addSheetTrackId)} />))
            )}
          </div>
        </BottomSheetBackdrop>
      )}

      {bulkAddSheetOpen && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => setBulkAddSheetOpen(false)}>
          <SheetHandle />
          <div className="px-5 pb-2 text-sm font-semibold">Add {selectedIds.length} songs to Playlist</div>
          <div className="max-h-64 overflow-y-auto">
            {playlists.length === 0 ? (<div className="px-5 py-4 text-xs" style={{ color: "#98989D" }}>No playlists yet. Create one from the Library tab.</div>) : (
              playlists.map((p) => (<SheetAction key={p.id} icon={<ListMusic size={17} color="#FA2D48" />} label={p.name} sub={`${p.trackIds.length} songs`} onClick={() => bulkAddToPlaylist(p.id)} />))
            )}
          </div>
        </BottomSheetBackdrop>
      )}

      {infoSheetTrackId && (() => {
        const t = library.find((tt) => tt.id === infoSheetTrackId);
        if (!t) return null;
        return (
          <BottomSheetBackdrop bg={sheetBg} onClose={() => setInfoSheetTrackId(null)}>
            <SheetHandle />
            <div className="flex items-center gap-3 px-5 pb-4"><ArtBox track={t} className="w-14 h-14 rounded-lg shrink-0" /><div className="min-w-0"><div className="text-sm font-semibold truncate">{t.name}</div><div className="text-xs" style={{ color: "#98989D" }}>{t.ext}</div></div></div>
            <div className="px-5 pb-6 flex flex-col gap-2 text-xs">
              <InfoRow label="Format" value={t.ext} />
              <InfoRow label="Duration" value={fmtTime(t.duration)} />
              <InfoRow label="Added" value={new Date(t.addedAt).toLocaleDateString()} />
              <InfoRow label="Play Count" value={String(playCounts[t.id] || 0)} />
              <InfoRow label="Album Art" value={t.artUrl ? "Embedded (found in file)" : "Not found — using generated cover"} />
              <InfoRow label="Liked" value={likedIds.includes(t.id) ? "Yes" : "No"} />
            </div>
          </BottomSheetBackdrop>
        );
      })()}

      {newPlaylistSheet && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => { setNewPlaylistSheet(false); setNewPlaylistFromQueue(false); }}>
          <SheetHandle />
          <div className="px-5 pb-4">
            <div className="text-sm font-semibold mb-3">{newPlaylistFromQueue ? "Save Queue as Playlist" : "New Playlist"}</div>
            <div className="flex items-center gap-2">
              <input autoFocus value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createPlaylist()} placeholder="Playlist name" className="flex-1 px-3 py-2.5 rounded-lg outline-none text-sm" style={{ background: "#2C2C2E", color: "#FFFFFF" }} />
              <button onClick={createPlaylist} className="press px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: "#FA2D48", color: "#FFFFFF" }}>Create</button>
            </div>
          </div>
        </BottomSheetBackdrop>
      )}

      {/* WOW — rename a track's display title */}
      {renameTrackId && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => setRenameTrackId(null)}>
          <SheetHandle />
          <div className="px-5 pb-4">
            <div className="text-sm font-semibold mb-3">Rename Track</div>
            <div className="flex items-center gap-2">
              <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && renameTrack(renameTrackId, renameDraft)} placeholder="Track name" className="flex-1 px-3 py-2.5 rounded-lg outline-none text-sm" style={{ background: "#2C2C2E", color: "#FFFFFF" }} />
              <button onClick={() => renameTrack(renameTrackId, renameDraft)} className="press px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: "#FA2D48", color: "#FFFFFF" }}>Save</button>
            </div>
          </div>
        </BottomSheetBackdrop>
      )}

      {/* WOW — Settings sheet: theme, normalization, smart continue, storage, backup, folder import */}
      {showSettings && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => setShowSettings(false)}>
          <SheetHandle />
          <div className="px-5 pb-6" style={{ color: palette.text }}>
            <div className="text-sm font-semibold mb-3">Settings</div>

            <div className="text-xs mb-2" style={{ color: palette.subtext }}>THEME</div>
            <div className="flex gap-2 mb-5">
              {Object.keys(THEMES).map((k) => (
                <button key={k} onClick={() => setTheme(k)} className="press flex-1 py-2 rounded-lg text-xs font-medium capitalize" style={{ background: THEMES[k].bg, color: THEMES[k].text, border: theme === k ? `2px solid ${THEMES[k].accent}` : "1px solid rgba(128,128,128,0.3)" }}>{k}</button>
              ))}
            </div>

            <SettingRow label="Normalize Volume" sub="Even out loud/quiet tracks" value={normalizeVolume} onChange={() => setNormalizeVolume((v) => !v)} palette={palette} />
            <SettingRow label="Smart Continue" sub="Keep playing similar songs when the queue ends" value={smartContinueEnabled} onChange={() => setSmartContinueEnabled((v) => !v)} palette={palette} />

            <div className="text-xs mt-5 mb-2" style={{ color: palette.subtext }}>CROSSFADE</div>
            <div className="flex gap-2 mb-1">
              {[0, 2, 3, 5, 8].map((s) => (
                <button key={s} onClick={() => setCrossfadeSec(s)} className="press flex-1 py-2 rounded-lg text-xs font-medium" style={{ background: crossfadeSec === s ? palette.accent : palette.surface, color: crossfadeSec === s ? "#fff" : palette.subtext }}>{s === 0 ? "Off" : `${s}s`}</button>
              ))}
            </div>
            <div className="text-xs mb-5" style={{ color: palette.subtext }}>{crossfadeSec === 0 ? "Tracks cut cleanly to the next one" : `Blends ${crossfadeSec}s into the next track`}</div>

            <div className="text-xs mt-5 mb-2" style={{ color: palette.subtext }}>LIBRARY</div>
            <button onClick={() => folderInputRef.current?.click()} className="press w-full flex items-center justify-between py-2.5 text-sm">
              <span>Import Folder (auto-playlist)</span><ChevronDown size={15} style={{ transform: "rotate(-90deg)", color: palette.subtext }} />
            </button>
            <button onClick={exportPlaylists} className="press w-full flex items-center justify-between py-2.5 text-sm">
              <span>Export Playlists</span><ChevronDown size={15} style={{ transform: "rotate(-90deg)", color: palette.subtext }} />
            </button>
            <button onClick={() => backupInputRef.current?.click()} className="press w-full flex items-center justify-between py-2.5 text-sm">
              <span>Import Playlists Backup</span><ChevronDown size={15} style={{ transform: "rotate(-90deg)", color: palette.subtext }} />
            </button>

            <div className="text-xs mt-5 mb-2" style={{ color: palette.subtext }}>STORAGE</div>
            {storageEstimate ? (
              <div>
                <div className="h-2 rounded-full overflow-hidden mb-1.5" style={{ background: palette.surface2 }}>
                  <div className="h-full" style={{ width: `${Math.min(100, (storageEstimate.usage / (storageEstimate.quota || 1)) * 100)}%`, background: palette.accent }} />
                </div>
                <div className="text-xs" style={{ color: palette.subtext }}>{(storageEstimate.usage / 1048576).toFixed(0)} MB used of {(storageEstimate.quota / 1048576).toFixed(0)} MB available</div>
              </div>
            ) : (<div className="text-xs" style={{ color: palette.subtext }}>Storage info not available on this browser</div>)}
          </div>
        </BottomSheetBackdrop>
      )}

      {/* WOW — Listening Stats dashboard */}
      {showStats && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => setShowStats(false)}>
          <SheetHandle />
          <div className="px-5 pb-6" style={{ color: palette.text }}>
            <div className="text-sm font-semibold mb-4">Listening Stats</div>
            <div className="flex gap-3 mb-5">
              <div className="flex-1 rounded-xl p-3" style={{ background: palette.surface }}>
                <div className="text-2xl font-extrabold">{weeklyPlays.length}</div>
                <div className="text-xs" style={{ color: palette.subtext }}>plays this week</div>
              </div>
              <div className="flex-1 rounded-xl p-3" style={{ background: palette.surface }}>
                <div className="text-2xl font-extrabold">{weeklyMinutes}</div>
                <div className="text-xs" style={{ color: palette.subtext }}>minutes this week</div>
              </div>
              <div className="flex-1 rounded-xl p-3" style={{ background: palette.surface }}>
                <div className="text-2xl font-extrabold">{totalLifetimePlays}</div>
                <div className="text-xs" style={{ color: palette.subtext }}>lifetime plays</div>
              </div>
            </div>
            <div className="text-xs mb-2" style={{ color: palette.subtext }}>TOP THIS WEEK</div>
            {weeklyTop.length === 0 ? (
              <div className="text-xs" style={{ color: palette.subtext }}>Play something to start building your stats.</div>
            ) : weeklyTop.map(({ track, count }) => (
              <div key={track.id} className="flex items-center gap-3 py-2">
                <ArtBox track={track} className="w-10 h-10 rounded-md shrink-0" />
                <div className="flex-1 min-w-0 text-sm truncate">{track.name}</div>
                <div className="text-xs" style={{ color: palette.subtext }}>{count}×</div>
              </div>
            ))}
          </div>
        </BottomSheetBackdrop>
      )}

      {/* WOW — mood tag picker */}
      {tagSheetTrackId && (
        <BottomSheetBackdrop bg={sheetBg} onClose={() => setTagSheetTrackId(null)}>
          <SheetHandle />
          <div className="px-5 pb-2 text-sm font-semibold">Mood Tags</div>
          <div className="px-5 pb-6 flex flex-wrap gap-2">
            {MOOD_TAGS.map((tag) => {
              const active = (tagsMap[tagSheetTrackId] || []).includes(tag);
              return (
                <button key={tag} onClick={() => toggleTag(tagSheetTrackId, tag)} className="press px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: active ? "#FA2D48" : "rgba(255,255,255,0.1)", color: active ? "#fff" : palette.subtext }}>{tag}</button>
              );
            })}
          </div>
        </BottomSheetBackdrop>
      )}

      {/* WOW — milestone confetti */}
      {confettiMilestone && <Confetti />}

      {/* hidden canvas/video used to power the floating Picture-in-Picture mini player */}
      <canvas ref={pipCanvasRef} className="hidden" />
      <video ref={pipVideoRef} muted playsInline className="hidden" />

      <audio ref={audioARef} onTimeUpdate={onTimeUpdateFor("A")} onLoadedMetadata={onLoadedMetadataFor("A")} onEnded={onEndedFor("A")} onError={onAudioErrorFor("A")} />
      <audio ref={audioBRef} onTimeUpdate={onTimeUpdateFor("B")} onLoadedMetadata={onLoadedMetadataFor("B")} onEnded={onEndedFor("B")} onError={onAudioErrorFor("B")} />
    </div>
  );
}

// =====================================================================
function ArtBox({ track, className, children }) {
  return (
    <div className={`${className} glass-tile`} style={{ background: artGradient(track.name), position: "relative", overflow: "hidden" }}>
      {track.artUrl && <img src={track.artUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />}
      {!track.artUrl && children}
    </div>
  );
}
function EmptyState({ dragOver, message }) {
  return (<div className="flex flex-col items-center justify-center gap-3 py-20 px-6 text-center"><Upload size={26} color={dragOver ? "#FA2D48" : "#5A5A5C"} /><p className="text-sm max-w-xs" style={{ color: "#98989D" }}>{message}</p></div>);
}
function HomeRow({ title, icon, tracks, onPlay }) {
  const wrapRef = useRef(null);
  const itemRefs = useRef([]);
  const rafRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      itemRefs.current.forEach((item) => {
        if (!item) return;
        const r = item.getBoundingClientRect();
        const dist = Math.abs(r.left + r.width / 2 - centerX);
        const t = Math.max(0, 1 - dist / (rect.width * 0.9));
        const scale = 0.9 + t * 0.1;
        item.style.transform = `scale(${scale})`;
        item.style.opacity = String(0.75 + t * 0.25);
      });
      rafRef.current = null;
    };
    const onScroll = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(update); };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [tracks.length]);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-lg font-bold mb-3">{icon}{title}</div>
      <div ref={wrapRef} className="hscroll pb-2">
        {tracks.map((t, i) => (
          <button key={t.id} ref={(el) => (itemRefs.current[i] = el)} onClick={() => onPlay(i)} className="press shrink-0 w-32 text-left relative" style={{ transition: `transform 0.15s ${SPRING}, opacity 0.15s` }}>
            <div className="absolute rounded-full" style={{ inset: "8%", background: `hsl(${artHue(t.name)} 70% 45%)`, filter: "blur(22px)", opacity: 0.45, zIndex: 0 }} />
            <ArtBox track={t} className="relative w-32 h-32 rounded-2xl mb-2" />
            <div className="text-sm font-medium truncate">{t.name}</div>
            <div className="text-xs" style={{ color: "#98989D" }}>{t.ext}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TrackRow({ t, isCurrent, isPlaying, onTap, onMenu, onSwipeDelete, liked, selectMode, selected, onToggleSelect, palette }) {
  const p = palette || THEMES.amoled;
  const [swipeX, setSwipeX] = useState(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const dragging = useRef(false);
  const longPressTimer = useRef(null);
  const suppressTap = useRef(false);

  const onTouchStart = (e) => {
    if (selectMode) return;
    startX.current = e.touches[0].clientX; startY.current = e.touches[0].clientY;
    dragging.current = false; suppressTap.current = false;
    if (onMenu) longPressTimer.current = setTimeout(() => { suppressTap.current = true; onMenu(); }, 480);
  };
  const onTouchMove = (e) => {
    if (selectMode) return;
    const dx = e.touches[0].clientX - startX.current, dy = e.touches[0].clientY - startY.current;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(longPressTimer.current);
    if (onSwipeDelete && Math.abs(dx) > Math.abs(dy)) { dragging.current = true; setSwipeX(Math.max(-84, Math.min(0, dx))); }
  };
  const onTouchEnd = () => {
    if (selectMode) return;
    clearTimeout(longPressTimer.current);
    if (dragging.current) { setSwipeX((x) => (x < -50 ? -84 : 0)); dragging.current = false; return; }
    if (!suppressTap.current) onTap();
  };
  const onContextMenu = (e) => { if (selectMode) return; e.preventDefault(); onMenu && onMenu(); };
  const handleClick = () => { if (selectMode) { onToggleSelect(); return; } if (swipeX === 0) onTap(); };

  return (
    <div className="relative overflow-hidden" style={{ borderRadius: 12 }}>
      {onSwipeDelete && !selectMode && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center justify-center" style={{ width: 84, background: "#FF453A" }}>
          <button onClick={() => { onSwipeDelete(); setSwipeX(0); }} className="press p-3"><Trash2 size={18} color="#fff" /></button>
        </div>
      )}
      <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onContextMenu={onContextMenu} onClick={handleClick}
        className="flex items-center gap-3 py-2.5" style={{ transform: `translateX(${swipeX}px)`, transition: dragging.current ? "none" : `transform 0.2s ${SPRING}`, background: p.bg }}>
        {selectMode && (selected ? <CheckCircle2 size={20} color={p.accent} className="shrink-0" /> : <Circle size={20} color={p.subtext} className="shrink-0" />)}
        <ArtBox track={t} className="w-11 h-11 rounded-lg shrink-0 flex items-center justify-center">
          {isCurrent && isPlaying ? (<div className="flex items-end gap-0.5 h-3.5"><div className="eq-bar" style={{ animationDelay: "0s", background: "#fff" }} /><div className="eq-bar" style={{ animationDelay: "0.2s", background: "#fff" }} /><div className="eq-bar" style={{ animationDelay: "0.4s", background: "#fff" }} /></div>) : (<Music size={15} color="rgba(255,255,255,0.6)" />)}
        </ArtBox>
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate flex items-center gap-1.5" style={{ color: isCurrent ? p.accent : p.text }}>
            {t.name}
            {liked && <Heart size={11} fill={p.accent} color={p.accent} className="shrink-0" />}
          </div>
          <div className="text-xs" style={{ color: p.subtext }}>{t.ext}{t.duration ? ` · ${fmtTime(t.duration)}` : ""}</div>
        </div>
        {onMenu && !selectMode && <button onClick={(e) => { e.stopPropagation(); onMenu(); }} className="press p-2 shrink-0" style={{ color: p.subtext }}><MoreHorizontal size={18} /></button>}
      </div>
    </div>
  );
}

function BottomSheetBackdrop({ onClose, children, bg }) {
  return (<><div className="absolute inset-0 fade-in" style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)", zIndex: 80 }} onClick={onClose} /><div className="glass sheet-enter absolute left-0 right-0 bottom-0 rounded-t-3xl pb-8 pt-2" style={{ background: bg || "#1C1C1E", zIndex: 81, maxHeight: "70vh", overflowY: "auto", border: "none", borderTop: "1px solid rgba(255,255,255,0.16)", boxShadow: "0 -16px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.12)" }}>{children}</div></>);
}
function SheetHandle() { return <div className="w-9 h-1 rounded-full mx-auto mb-3" style={{ background: "rgba(255,255,255,0.25)" }} />; }
function SheetAction({ icon, label, sub, onClick, danger }) {
  return (<button onClick={onClick} className="press w-full flex items-center gap-3 px-5 py-3 text-left"><span style={{ color: danger ? "#FF453A" : "#FA2D48" }}>{icon}</span><span className="text-sm flex-1" style={{ color: danger ? "#FF453A" : "#FFFFFF" }}>{label}</span>{sub && <span className="text-xs" style={{ color: "#98989D" }}>{sub}</span>}</button>);
}
function InfoRow({ label, value }) {
  return (<div className="flex items-center justify-between py-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}><span style={{ color: "#98989D" }}>{label}</span><span>{value}</span></div>);
}
function SettingRow({ label, sub, value, onChange, palette }) {
  return (
    <button onClick={onChange} className="press w-full flex items-center justify-between py-2.5 text-left">
      <div><div className="text-sm">{label}</div>{sub && <div className="text-xs" style={{ color: palette.subtext }}>{sub}</div>}</div>
      <div className="w-11 h-6 rounded-full relative shrink-0" style={{ background: value ? "#FA2D48" : "rgba(128,128,128,0.35)", transition: "background 0.15s" }}>
        <div className="absolute top-0.5 w-5 h-5 rounded-full bg-white" style={{ left: value ? 22 : 2, transition: "left 0.15s" }} />
      </div>
    </button>
  );
}
function Confetti() {
  const pieces = Array.from({ length: 40 }, (_, i) => i);
  const colors = ["#FA2D48", "#FFD60A", "#30D158", "#64D2FF", "#BF5AF2"];
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 90 }}>
      <style>{`
        @keyframes confettiFall { 0% { transform: translateY(-10vh) rotate(0deg); opacity: 1; } 100% { transform: translateY(110vh) rotate(540deg); opacity: 0; } }
      `}</style>
      {pieces.map((i) => (
        <div key={i} style={{
          position: "absolute", left: `${Math.random() * 100}%`, top: "-5%",
          width: 8, height: 8, background: colors[i % colors.length],
          borderRadius: i % 2 ? "50%" : "2px",
          animation: `confettiFall ${1.6 + Math.random() * 1.2}s ease-in forwards`,
          animationDelay: `${Math.random() * 0.4}s`,
        }} />
      ))}
    </div>
  );
}
function LyricsPanel({ track, text, onSave, onBack }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => { setDraft(text); setEditing(false); }, [track?.id]);
  return (
    <div className="flex-1 flex flex-col px-5 overflow-hidden">
      <div className="flex items-center justify-between py-2">
        <button onClick={onBack} className="press flex items-center gap-1 text-sm font-medium"><ChevronDown size={17} /> Back</button>
        {!editing ? (<button onClick={() => setEditing(true)} className="press text-sm font-medium" style={{ color: "#FA2D48" }}>{text ? "Edit" : "Add Lyrics"}</button>) : (<button onClick={() => { onSave(draft); setEditing(false); }} className="press text-sm font-medium" style={{ color: "#FA2D48" }}>Save</button>)}
      </div>
      {editing ? (<textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste or type lyrics here…" className="flex-1 bg-transparent outline-none text-sm leading-relaxed resize-none" style={{ color: "#FFFFFF" }} />) : (<div className="flex-1 overflow-y-auto text-base leading-loose whitespace-pre-wrap" style={{ color: text ? "#FFFFFF" : "#98989D" }}>{text || "No lyrics added yet. Tap \"Add Lyrics\" to write or paste them in."}</div>)}
    </div>
  );
}
