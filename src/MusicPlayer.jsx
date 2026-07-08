import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  Upload, Plus, Trash2, Music, ListMusic, Volume2, VolumeX, X,
  Disc3, Search, SlidersHorizontal, Moon, GripVertical, ChevronDown,
  ChevronRight, Home, Library as LibraryIcon, MoreHorizontal,
  ListPlus, CornerDownRight, Info, Mic2, ArrowLeft, LayoutGrid,
  List as ListIcon, ArrowUpDown, Clock, TrendingUp
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
    return { peaks: peaks.map((p) => p / peakMax), duration: audioBuffer.duration };
  } catch {
    return { peaks: null, duration: 0 };
  }
}

// ---- embedded album art extraction (ID3v2 APIC for MP3, PICTURE block for FLAC) ----
async function extractIdMp3Art(file) {
  try {
    const head = await file.slice(0, 10).arrayBuffer();
    const h = new Uint8Array(head);
    if (!(h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33)) return null; // "ID3"
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
        p += 1; // picture type byte
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
    if (!(sig[0] === 0x66 && sig[1] === 0x4c && sig[2] === 0x61 && sig[3] === 0x43)) return null; // "fLaC"
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

// ---- IndexedDB persistence (survives app close / background kill) ----
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

// =====================================================================
export default function MusicPlayer() {
  const [loaded, setLoaded] = useState(false);
  const [library, setLibrary] = useState([]); // {id,name,ext,file,peaks,duration,addedAt,artUrl}
  const [playlists, setPlaylists] = useState([]);
  const [lyricsMap, setLyricsMap] = useState({});
  const [playCounts, setPlayCounts] = useState({});
  const [recentlyPlayed, setRecentlyPlayed] = useState([]);
  const [positions, setPositions] = useState({}); // {trackId: seconds} — resume support

  const [activeTab, setActiveTab] = useState("home");
  const [openPlaylistId, setOpenPlaylistId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [librarySort, setLibrarySort] = useState("recent");
  const [libraryView, setLibraryView] = useState("list");
  const [showSortMenu, setShowSortMenu] = useState(false);

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

  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [npView, setNpView] = useState("player");
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [artSwipeX, setArtSwipeX] = useState(0);
  const [showEq, setShowEq] = useState(false);
  const [eqBands, setEqBands] = useState({ bass: 0, mid: 0, treble: 0 });
  const [showSleep, setShowSleep] = useState(false);
  const [sleepEndsAt, setSleepEndsAt] = useState(null);
  const [sleepRemaining, setSleepRemaining] = useState(null);

  const [addSheetTrackId, setAddSheetTrackId] = useState(null);
  const [contextTrackId, setContextTrackId] = useState(null);
  const [contextInfo, setContextInfo] = useState(null);
  const [infoSheetTrackId, setInfoSheetTrackId] = useState(null);
  const [newPlaylistSheet, setNewPlaylistSheet] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [toast, setToast] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [rowDragIdx, setRowDragIdx] = useState(null);

  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const vuCanvasRef = useRef(null);
  const waveCanvasRef = useRef(null);
  const waveWrapRef = useRef(null);
  const bgGlowRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const masterGainRef = useRef(null);
  const eqRefs = useRef({});
  const rafRef = useRef(null);
  const sleepTimeoutRef = useRef(null);
  const sleepFadeTimeoutRef = useRef(null);
  const currentUrlRef = useRef(null);
  const touchStartY = useRef(0);
  const artTouchStartX = useRef(0);
  const toastTimer = useRef(null);
  const resumeSeekRef = useRef(null);
  const lastSaveRef = useRef(0);

  const currentTrack = library.find((t) => t.id === queue[queueIndex]) || null;
  const activePlaylist = playlists.find((p) => p.id === openPlaylistId) || null;

  const showToast = (msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 1800); };

  // ------------------------------------------------------------------
  // load persisted state on first mount
  // ------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const tracks = await idbGetAllTracks();
        setLibrary(tracks.map((r) => ({
          id: r.id, name: r.name, ext: r.ext, duration: r.duration, peaks: r.peaks,
          addedAt: r.addedAt, file: r.blob, artUrl: r.artBlob ? URL.createObjectURL(r.artBlob) : null,
        })));
        const pl = await idbGetMeta("playlists"); if (pl) setPlaylists(pl);
        const ly = await idbGetMeta("lyrics"); if (ly) setLyricsMap(ly);
        const pc = await idbGetMeta("playCounts"); if (pc) setPlayCounts(pc);
        const rp = await idbGetMeta("recentlyPlayed"); if (rp) setRecentlyPlayed(rp);
        const ps = await idbGetMeta("positions"); if (ps) setPositions(ps);
      } catch { /* fresh start if IndexedDB unavailable */ }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (loaded) idbSetMeta("playlists", playlists); }, [playlists, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("lyrics", lyricsMap); }, [lyricsMap, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("playCounts", playCounts); }, [playCounts, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("recentlyPlayed", recentlyPlayed); }, [recentlyPlayed, loaded]);
  useEffect(() => { if (loaded) idbSetMeta("positions", positions); }, [positions, loaded]);

  // ------------------------------------------------------------------
  // smart / computed lists
  // ------------------------------------------------------------------
  const recentlyAdded = [...library].sort((a, b) => b.addedAt - a.addedAt).slice(0, 25);
  const recentlyPlayedTracks = recentlyPlayed.map((id) => library.find((t) => t.id === id)).filter(Boolean).slice(0, 25);
  const mostPlayed = [...library].filter((t) => playCounts[t.id] > 0).sort((a, b) => (playCounts[b.id] || 0) - (playCounts[a.id] || 0)).slice(0, 25);

  const sortedLibrary = (() => {
    const arr = [...library];
    if (librarySort === "name") arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (librarySort === "duration") arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    else arr.sort((a, b) => b.addedAt - a.addedAt);
    return arr;
  })();

  const playlistTracks = activePlaylist ? activePlaylist.trackIds.map((tid) => library.find((t) => t.id === tid)).filter(Boolean) : [];

  // ------------------------------------------------------------------
  // Web Audio graph: source -> bass -> mid -> treble -> analyser -> masterGain -> out
  // ------------------------------------------------------------------
  const ensureAudioGraph = useCallback(() => {
    if (!audioRef.current || audioCtxRef.current) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaElementSource(audioRef.current);
    const bass = ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 200;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 1;
    const treble = ctx.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 64;
    const masterGain = ctx.createGain(); masterGain.gain.value = 1;
    source.connect(bass); bass.connect(mid); mid.connect(treble);
    treble.connect(analyser); analyser.connect(masterGain); masterGain.connect(ctx.destination);
    audioCtxRef.current = ctx; analyserRef.current = analyser; masterGainRef.current = masterGain;
    eqRefs.current = { bass, mid, treble };
  }, []);

  useEffect(() => {
    const { bass, mid, treble } = eqRefs.current;
    if (bass) bass.gain.value = eqBands.bass;
    if (mid) mid.gain.value = eqBands.mid;
    if (treble) treble.gain.value = eqBands.treble;
  }, [eqBands]);

  const fadeTo = (target, ms) => {
    const g = masterGainRef.current, ctx = audioCtxRef.current;
    if (!g || !ctx) return Promise.resolve();
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(target, now + ms / 1000);
    return new Promise((res) => setTimeout(res, ms));
  };

  // ------------------------------------------------------------------
  // VU + waveform + reactive background pulse — one shared draw loop
  // ------------------------------------------------------------------
  useEffect(() => {
    const draw = () => {
      let level = 0;
      const hasData = analyserRef.current && isPlaying;
      let data = null;
      if (hasData) {
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
          c.fillStyle = l > 0.82 ? "#FF375F" : "#FA2D48";
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
            c.fillStyle = i / peaks.length < progressRatio ? "#FFFFFF" : "rgba(255,255,255,0.25)";
            c.fillRect(x, y, Math.max(1, barW - 1), barH);
          });
        } else {
          c.fillStyle = "rgba(255,255,255,0.2)"; c.fillRect(0, h / 2 - 1, w, 2);
          c.fillStyle = "#FFFFFF"; c.fillRect(0, h / 2 - 1, w * progressRatio, 2);
        }
      }

      // WOW #3 — ambient background breathes with the music's live energy
      if (bgGlowRef.current) {
        bgGlowRef.current.style.transform = `scale(${1 + level * 0.18})`;
        bgGlowRef.current.style.opacity = String(0.5 + level * 0.35);
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, currentTrack, currentTime, duration]);

  useEffect(() => {
    const resize = () => {
      if (waveCanvasRef.current && waveWrapRef.current) {
        waveCanvasRef.current.width = waveWrapRef.current.clientWidth;
        waveCanvasRef.current.height = 44;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [nowPlayingOpen]);

  // ------------------------------------------------------------------
  // File import — extracts waveform peaks + embedded album art, persists to IndexedDB
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
      const [{ peaks, duration }, artBlob] = await Promise.all([computePeaks(d.file), extractEmbeddedArt(d.file)]);
      const artUrl = artBlob ? URL.createObjectURL(artBlob) : null;
      setLibrary((prev) => prev.map((t) => (t.id === d.id ? { ...t, peaks, duration: duration || t.duration, artUrl } : t)));
      idbPutTrack({ id: d.id, name: d.name, ext: d.ext, duration: duration || 0, peaks, addedAt: d.addedAt, blob: d.file, artBlob });
    }
  };

  const onFileInputChange = (e) => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ""; };
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) importFiles(e.dataTransfer.files); };

  // ------------------------------------------------------------------
  // Playback engine
  // ------------------------------------------------------------------
  const loadTrackById = async (id, autoplay = true, { fade = false } = {}) => {
    const track = library.find((t) => t.id === id);
    if (!track) return;
    ensureAudioGraph();

    // save resume position of the track we're leaving
    if (currentTrack && audioRef.current) {
      setPositions((prev) => ({ ...prev, [currentTrack.id]: audioRef.current.currentTime }));
    }
    if (fade && isPlaying) await fadeTo(0, 280);

    if (currentUrlRef.current) { URL.revokeObjectURL(currentUrlRef.current); currentUrlRef.current = null; }
    const url = URL.createObjectURL(track.file);
    currentUrlRef.current = url;
    setCurrentTime(0);
    resumeSeekRef.current = positions[id] > 3 ? positions[id] : null;
    setRecentlyPlayed((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, 50));
    setPlayCounts((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));

    requestAnimationFrame(() => {
      if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
      if (audioRef.current) {
        audioRef.current.src = url;
        if (autoplay) { audioRef.current.play().catch(() => {}); setIsPlaying(true); }
      }
      if (masterGainRef.current && audioCtxRef.current) masterGainRef.current.gain.setValueAtTime(fade ? 0 : 1, audioCtxRef.current.currentTime);
      if (fade) fadeTo(1, 320);
    });
  };

  const onAudioError = () => {
    if (!currentTrack) return;
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    const url = URL.createObjectURL(currentTrack.file);
    currentUrlRef.current = url;
    audioRef.current.src = url;
    if (isPlaying) audioRef.current.play().catch(() => {});
  };

  useEffect(() => () => { if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current); }, []);

  const playFrom = (list, index, sourceLabel) => {
    const ids = list.map((t) => t.id);
    setQueue(ids); setQueueIndex(index); setQueueSource(sourceLabel);
    loadTrackById(ids[index], true);
  };

  const togglePlay = () => {
    if (!audioRef.current || !currentTrack) return;
    ensureAudioGraph();
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
    if (isPlaying) { audioRef.current.pause(); setIsPlaying(false); }
    else { audioRef.current.play().catch(() => {}); setIsPlaying(true); }
  };

  const stepTrack = (dir) => {
    if (!queue.length) return;
    let idx = queueIndex;
    if (shuffle) {
      let next = Math.floor(Math.random() * queue.length);
      if (queue.length > 1) while (next === idx) next = Math.floor(Math.random() * queue.length);
      setQueueIndex(next); loadTrackById(queue[next], true, { fade: true });
      return;
    }
    let next = idx + dir;
    if (next < 0) next = queue.length - 1;
    if (next >= queue.length) next = 0;
    setQueueIndex(next); loadTrackById(queue[next], true, { fade: true });
  };

  const onEnded = () => {
    if (repeatMode === "one") { audioRef.current.currentTime = 0; audioRef.current.play(); return; }
    const isLast = queueIndex === queue.length - 1;
    if (isLast && repeatMode === "off" && !shuffle) { setIsPlaying(false); return; }
    stepTrack(1);
  };

  const cycleRepeat = () => setRepeatMode((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"));

  const seekTo = (t) => {
    if (!audioRef.current) return;
    const clamped = Math.max(0, Math.min(duration || 0, t));
    audioRef.current.currentTime = clamped; setCurrentTime(clamped);
  };
  const onWaveClick = (e) => {
    if (!waveCanvasRef.current || !duration) return;
    const rect = waveCanvasRef.current.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  };
  const onVolumeChange = (e) => {
    const v = Number(e.target.value); setVolume(v); setMuted(false);
    if (audioRef.current) audioRef.current.volume = v;
  };
  useEffect(() => { if (audioRef.current) audioRef.current.volume = muted ? 0 : volume; }, [volume, muted]);

  const onTimeUpdate = (e) => {
    const t = e.target.currentTime;
    setCurrentTime(t);
    if (currentTrack && t - lastSaveRef.current > 5) {
      lastSaveRef.current = t;
      setPositions((prev) => ({ ...prev, [currentTrack.id]: t }));
    }
  };
  const onLoadedMetadata = (e) => {
    setDuration(e.target.duration);
    if (resumeSeekRef.current) {
      e.target.currentTime = resumeSeekRef.current;
      setCurrentTime(resumeSeekRef.current);
      resumeSeekRef.current = null;
    }
  };

  // ------------------------------------------------------------------
  // queue actions
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
  const removeFromQueue = (idx) => {
    setQueue((prev) => prev.filter((_, i) => i !== idx));
    if (idx < queueIndex) setQueueIndex((q) => q - 1);
  };
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

  // ------------------------------------------------------------------
  // keyboard shortcuts
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // WOW #2 — MediaSession: clean lock-screen / notification (title + app name only)
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: currentTrack.name,
      artist: "Spool",
      album: "",
      artwork: currentTrack.artUrl ? [{ src: currentTrack.artUrl, sizes: "512x512", type: "image/png" }] : [],
    });
  }, [currentTrack]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => stepTrack(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => stepTrack(1));
    navigator.mediaSession.setActionHandler("seekto", (d) => { if (d.seekTime != null) seekTo(d.seekTime); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queueIndex, shuffle, repeatMode, isPlaying, duration]);

  // ------------------------------------------------------------------
  // sleep timer — WOW #5: fades out over the last stretch instead of a hard cut
  // ------------------------------------------------------------------
  const setSleepMinutes = (mins) => {
    clearTimeout(sleepTimeoutRef.current);
    clearTimeout(sleepFadeTimeoutRef.current);
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
      if (audioRef.current) audioRef.current.pause();
      setIsPlaying(false); setSleepEndsAt(null); setSleepRemaining(null);
      if (masterGainRef.current && audioCtxRef.current) masterGainRef.current.gain.setValueAtTime(1, audioCtxRef.current.currentTime);
    }, totalMs);
  };
  useEffect(() => {
    if (!sleepEndsAt) return;
    const iv = setInterval(() => {
      const remain = Math.max(0, sleepEndsAt - Date.now());
      setSleepRemaining(remain);
      if (remain <= 0) clearInterval(iv);
    }, 1000);
    return () => clearInterval(iv);
  }, [sleepEndsAt]);

  // ------------------------------------------------------------------
  // playlists
  // ------------------------------------------------------------------
  const createPlaylist = () => {
    const name = newPlaylistName.trim();
    if (!name) return;
    const pl = { id: uid(), name, trackIds: [] };
    setPlaylists((prev) => [...prev, pl]);
    setNewPlaylistName(""); setNewPlaylistSheet(false);
    setOpenPlaylistId(pl.id);
    showToast("Playlist created");
  };
  const deletePlaylist = (id) => {
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    if (openPlaylistId === id) setOpenPlaylistId(null);
    showToast("Playlist deleted");
  };
  const addToPlaylist = (playlistId, trackId) => {
    setPlaylists((prev) => prev.map((p) => (p.id === playlistId && !p.trackIds.includes(trackId) ? { ...p, trackIds: [...p.trackIds, trackId] } : p)));
    setAddSheetTrackId(null);
    showToast("Added to playlist");
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

  // ------------------------------------------------------------------
  // Now Playing gestures — drag sheet down to dismiss, swipe art to skip
  // ------------------------------------------------------------------
  const onSheetTouchStart = (e) => { touchStartY.current = e.touches[0].clientY; setDragging(true); };
  const onSheetTouchMove = (e) => { const dy = e.touches[0].clientY - touchStartY.current; if (dy > 0) setDragY(dy); };
  const onSheetTouchEnd = () => { setDragging(false); if (dragY > 110) setNowPlayingOpen(false); setDragY(0); };

  const onArtTouchStart = (e) => { artTouchStartX.current = e.touches[0].clientX; };
  const onArtTouchMove = (e) => { setArtSwipeX(e.touches[0].clientX - artTouchStartX.current); };
  const onArtTouchEnd = () => {
    if (artSwipeX < -70) stepTrack(1);
    else if (artSwipeX > 70) stepTrack(-1);
    setArtSwipeX(0);
  };

  // ------------------------------------------------------------------
  const q = searchQuery.trim().toLowerCase();
  const searchLibraryResults = q ? library.filter((t) => t.name.toLowerCase().includes(q)) : [];
  const searchPlaylistResults = q
    ? playlists.map((p) => ({ playlist: p, tracks: p.trackIds.map((id) => library.find((t) => t.id === id)).filter((t) => t && t.name.toLowerCase().includes(q)) })).filter((r) => r.tracks.length > 0)
    : [];

  const openContext = (trackId, mode, playlistId = null) => { setContextTrackId(trackId); setContextInfo({ mode, playlistId }); };
  const closeContext = () => { setContextTrackId(null); setContextInfo(null); };

  // ==================================================================
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden select-none" style={{ background: "#000000", color: "#FFFFFF", fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        input[type="range"] { -webkit-appearance:none; appearance:none; height:4px; background:rgba(255,255,255,0.2); border-radius:999px; outline:none; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:16px; height:16px; border-radius:50%; background:#FFFFFF; cursor:pointer; }
        input[type="range"]::-moz-range-thumb { width:16px; height:16px; border-radius:50%; background:#FFFFFF; cursor:pointer; border:none; }
        input[type="range"].vert { writing-mode: vertical-lr; direction: rtl; width:4px; height:90px; }
        ::-webkit-scrollbar { display: none; }
        .press:active { transform: scale(0.94); }
        .press { transition: transform 0.12s ${SPRING}; }
        .sheet-enter { animation: slideUp 0.28s ${SPRING}; }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .eq-bar { width: 3px; background: #FA2D48; border-radius: 2px; animation: eqPulse 0.9s ease-in-out infinite; }
        @keyframes eqPulse { 0%,100% { height: 4px; } 50% { height: 14px; } }
        .hscroll { display: flex; overflow-x: auto; gap: 12px; scroll-snap-type: x proximity; }
        .hscroll > * { scroll-snap-align: start; }
        .fade-in { animation: fadeIn 0.2s ease-out; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      {toast && (
        <div className="fade-in absolute top-3 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-xs font-medium" style={{ background: "rgba(40,40,42,0.95)", zIndex: 70, backdropFilter: "blur(20px)" }}>{toast}</div>
      )}

      <header className="flex items-center justify-between px-4 shrink-0" style={{ height: 54 }}>
        <h1 className="text-2xl font-extrabold tracking-tight">{activeTab === "home" ? "Home" : activeTab === "library" ? (openPlaylistId ? "" : "Library") : "Search"}</h1>
        {!openPlaylistId && (
          <button onClick={() => fileInputRef.current?.click()} className="press p-2 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }}><Upload size={17} /></button>
        )}
        {openPlaylistId && (
          <button onClick={() => setOpenPlaylistId(null)} className="press flex items-center gap-1 text-sm font-medium" style={{ color: "#FA2D48" }}><ArrowLeft size={18} /> Library</button>
        )}
        <input ref={fileInputRef} type="file" accept="audio/*" multiple onChange={onFileInputChange} className="hidden" />
      </header>

      <main className="flex-1 overflow-y-auto px-4" style={{ paddingBottom: currentTrack ? 148 : 78 }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {activeTab === "home" && (
          <div className="flex flex-col gap-6 pt-1">
            {library.length === 0 ? (
              <EmptyState dragOver={dragOver} message="Import some tracks to get started. Drag files anywhere, or tap the upload icon above." />
            ) : (
              <>
                <HomeRow title="Recently Added" tracks={recentlyAdded} onPlay={(i) => playFrom(recentlyAdded, i, "Recently Added")} />
                {recentlyPlayedTracks.length > 0 && <HomeRow title="Recently Played" icon={<Clock size={14} />} tracks={recentlyPlayedTracks} onPlay={(i) => playFrom(recentlyPlayedTracks, i, "Recently Played")} />}
                {mostPlayed.length > 0 && <HomeRow title="Most Played" icon={<TrendingUp size={14} />} tracks={mostPlayed} onPlay={(i) => playFrom(mostPlayed, i, "Most Played")} />}
                {playlists.length > 0 && (
                  <div>
                    <div className="text-lg font-bold mb-3">Your Playlists</div>
                    <div className="hscroll pb-2">
                      {playlists.map((p) => (
                        <button key={p.id} onClick={() => { setActiveTab("library"); setOpenPlaylistId(p.id); }} className="press shrink-0 w-32 text-left">
                          <div className="w-32 h-32 rounded-xl flex items-center justify-center mb-2" style={{ background: "#1C1C1E" }}><ListMusic size={26} color="#FA2D48" /></div>
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
              <div className="flex-1" />
              <button onClick={() => setLibraryView((v) => (v === "list" ? "grid" : "list"))} className="press p-2 rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>{libraryView === "list" ? <LayoutGrid size={15} /> : <ListIcon size={15} />}</button>
              <div className="relative">
                <button onClick={() => setShowSortMenu((s) => !s)} className="press p-2 rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}><ArrowUpDown size={15} /></button>
                {showSortMenu && (
                  <div className="absolute right-0 top-10 rounded-xl py-1 w-40 fade-in" style={{ background: "#2C2C2E", zIndex: 30 }}>
                    {[["recent", "Recently Added"], ["name", "Name"], ["duration", "Duration"]].map(([k, l]) => (
                      <button key={k} onClick={() => { setLibrarySort(k); setShowSortMenu(false); }} className="block w-full text-left px-4 py-2 text-xs" style={{ color: librarySort === k ? "#FA2D48" : "#FFFFFF" }}>{l}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {playlists.length > 0 && (
              <div className="hscroll pb-3">
                {playlists.map((p) => (
                  <button key={p.id} onClick={() => setOpenPlaylistId(p.id)} className="press shrink-0 w-28 text-left">
                    <div className="w-28 h-28 rounded-xl flex items-center justify-center mb-1.5" style={{ background: "#1C1C1E" }}><ListMusic size={22} color="#FA2D48" /></div>
                    <div className="text-xs font-medium truncate">{p.name}</div>
                  </button>
                ))}
              </div>
            )}

            {sortedLibrary.length === 0 ? (
              <EmptyState dragOver={dragOver} message="Drag audio files anywhere, or tap the upload icon above. Nothing is re-encoded — original quality stays intact." />
            ) : libraryView === "grid" ? (
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
                  <TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying}
                    onTap={() => playFrom(sortedLibrary, i, "Library")} onMenu={() => openContext(t.id, "library")} onSwipeDelete={() => deleteFromLibrary(t.id)} />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "library" && openPlaylistId && (
          <div className="pt-1">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-20 h-20 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#1C1C1E" }}><ListMusic size={30} color="#FA2D48" /></div>
              <div>
                <div className="text-xl font-extrabold">{activePlaylist?.name}</div>
                <div className="text-xs" style={{ color: "#98989D" }}>{playlistTracks.length} songs</div>
              </div>
              <button onClick={() => deletePlaylist(openPlaylistId)} className="press ml-auto p-2" style={{ color: "#7A3A22" }}><Trash2 size={17} /></button>
            </div>
            {playlistTracks.length === 0 ? (
              <EmptyState dragOver={false} message="This playlist is empty. Go to a track's ⋯ menu in Library to add it here." />
            ) : (
              playlistTracks.map((t, i) => (
                <TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying}
                  onTap={() => playFrom(playlistTracks, i, activePlaylist.name)} onMenu={() => openContext(t.id, "playlist", openPlaylistId)} onSwipeDelete={() => removeFromPlaylist(openPlaylistId, t.id)} />
              ))
            )}
          </div>
        )}

        {activeTab === "search" && (
          <div className="pt-1">
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl mb-4" style={{ background: "#1C1C1E" }}>
              <Search size={15} color="#98989D" />
              <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Artists, Songs, Playlists" className="bg-transparent outline-none text-sm flex-1" style={{ color: "#FFFFFF" }} />
              {searchQuery && <button onClick={() => setSearchQuery("")}><X size={15} color="#98989D" /></button>}
            </div>
            {!q ? (
              <div className="text-sm text-center py-16" style={{ color: "#98989D" }}>Search your library and playlists</div>
            ) : (
              <>
                {searchLibraryResults.length === 0 && searchPlaylistResults.length === 0 && <div className="text-sm text-center py-16" style={{ color: "#98989D" }}>No results for "{searchQuery}"</div>}
                {searchLibraryResults.length > 0 && (
                  <div className="mb-5">
                    <div className="text-xs font-semibold tracking-wide mb-1" style={{ color: "#98989D" }}>LIBRARY</div>
                    {searchLibraryResults.map((t, i) => (
                      <TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying} onTap={() => playFrom(searchLibraryResults, i, "Search")} onMenu={() => openContext(t.id, "library")} />
                    ))}
                  </div>
                )}
                {searchPlaylistResults.map(({ playlist, tracks }) => (
                  <div key={playlist.id} className="mb-5">
                    <div className="text-xs font-semibold tracking-wide mb-1" style={{ color: "#98989D" }}>{playlist.name.toUpperCase()}</div>
                    {tracks.map((t, i) => (
                      <TrackRow key={t.id} t={t} isCurrent={t.id === currentTrack?.id} isPlaying={isPlaying} onTap={() => playFrom(tracks, i, playlist.name)} onMenu={() => openContext(t.id, "playlist", playlist.id)} />
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </main>

      {currentTrack && !nowPlayingOpen && (
        <div onClick={() => setNowPlayingOpen(true)} className="press absolute left-2 right-2 flex items-center gap-3 px-3 rounded-2xl fade-in" style={{ bottom: 66, height: 60, background: "rgba(44,44,46,0.85)", backdropFilter: "blur(24px)", zIndex: 20 }}>
          <ArtBox track={currentTrack} className="w-9 h-9 rounded-lg shrink-0" />
          <div className="flex-1 min-w-0 text-left"><div className="text-sm font-medium truncate">{currentTrack.name}</div></div>
          {isPlaying && (
            <div className="flex items-end gap-0.5 h-4 shrink-0">
              <div className="eq-bar" style={{ animationDelay: "0s" }} /><div className="eq-bar" style={{ animationDelay: "0.2s" }} /><div className="eq-bar" style={{ animationDelay: "0.4s" }} />
            </div>
          )}
          <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="press p-1.5 shrink-0">{isPlaying ? <Pause size={22} fill="#FFFFFF" /> : <Play size={22} fill="#FFFFFF" style={{ marginLeft: 2 }} />}</button>
          <button onClick={(e) => { e.stopPropagation(); stepTrack(1); }} className="press p-1.5 shrink-0"><SkipForward size={20} fill="#FFFFFF" /></button>
        </div>
      )}

      <nav className="absolute left-0 right-0 bottom-0 flex items-stretch" style={{ height: 66, background: "rgba(20,20,22,0.85)", backdropFilter: "blur(24px)", borderTop: "1px solid rgba(255,255,255,0.08)", zIndex: 21 }}>
        {[["home", "Home", <Home size={22} />], ["library", "Library", <LibraryIcon size={22} />], ["search", "Search", <Search size={22} />]].map(([key, label, icon]) => (
          <button key={key} onClick={() => { setActiveTab(key); if (key !== "library") setOpenPlaylistId(null); }} className="press flex-1 flex flex-col items-center justify-center gap-1" style={{ color: activeTab === key ? "#FA2D48" : "#98989D" }}>
            {icon}<span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </nav>

      {nowPlayingOpen && currentTrack && (
        <div className="sheet-enter absolute inset-0 flex flex-col overflow-hidden" style={{ zIndex: 60, transform: `translateY(${dragY}px)`, transition: dragging ? "none" : `transform 0.3s ${SPRING}` }}>
          <div className="absolute inset-0" style={{ background: "#0A0A0A" }} />
          <div ref={bgGlowRef} className="absolute" style={{ top: "-20%", left: "-20%", width: "140%", height: "70%", background: artGradient(currentTrack.name), filter: "blur(90px)", opacity: 0.55, transition: "transform 0.08s linear, opacity 0.08s linear" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.6) 55%, #0A0A0A 90%)" }} />

          <div className="relative flex flex-col h-full" onTouchStart={onSheetTouchStart} onTouchMove={onSheetTouchMove} onTouchEnd={onSheetTouchEnd}>
            <div className="flex flex-col items-center pt-2 pb-1 shrink-0"><div className="w-9 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.35)" }} /></div>
            <div className="flex items-center justify-between px-5 shrink-0" style={{ height: 44 }}>
              <button onClick={() => setNowPlayingOpen(false)} className="press p-1"><ChevronDown size={22} /></button>
              <div className="text-center"><div className="text-[10px] tracking-wider" style={{ color: "#98989D" }}>PLAYING FROM</div><div className="text-xs font-semibold">{queueSource}</div></div>
              <button onClick={() => setInfoSheetTrackId(currentTrack.id)} className="press p-1"><Info size={19} /></button>
            </div>

            {npView === "player" && (
              <div className="flex-1 flex flex-col items-center justify-center px-8 gap-6 overflow-y-auto">
                <div
                  className="w-full max-w-xs aspect-square rounded-2xl overflow-hidden shadow-2xl"
                  onTouchStart={onArtTouchStart} onTouchMove={onArtTouchMove} onTouchEnd={onArtTouchEnd}
                  style={{ transform: `translateX(${artSwipeX}px)`, transition: artSwipeX === 0 ? `transform 0.25s ${SPRING}` : "none" }}
                >
                  <ArtBox track={currentTrack} className="w-full h-full flex items-center justify-center">
                    {!currentTrack.artUrl && <Disc3 size={70} color="rgba(255,255,255,0.55)" className={isPlaying ? "animate-spin" : ""} style={{ animationDuration: "4s" }} />}
                  </ArtBox>
                </div>

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
                  <button onClick={() => setShuffle((s) => !s)} className="press" style={{ color: shuffle ? "#FA2D48" : "#98989D" }}><Shuffle size={19} /></button>
                  <button onClick={() => stepTrack(-1)} className="press"><SkipBack size={28} fill="#FFFFFF" /></button>
                  <button onClick={togglePlay} className="press w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "#FFFFFF" }}>
                    {isPlaying ? <Pause size={26} color="#000000" fill="#000000" /> : <Play size={26} color="#000000" fill="#000000" style={{ marginLeft: 3 }} />}
                  </button>
                  <button onClick={() => stepTrack(1)} className="press"><SkipForward size={28} fill="#FFFFFF" /></button>
                  <button onClick={cycleRepeat} className="press" style={{ color: repeatMode !== "off" ? "#FA2D48" : "#98989D" }}>{repeatMode === "one" ? <Repeat1 size={19} /> : <Repeat size={19} />}</button>
                </div>

                <canvas ref={vuCanvasRef} width={140} height={26} />

                <div className="w-full flex items-center gap-4">
                  <button onClick={() => setMuted((m) => !m)} style={{ color: "#98989D" }}>{muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
                  <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={onVolumeChange} className="flex-1" />
                </div>

                <div className="flex items-center gap-10 pb-2">
                  <button onClick={() => setNpView("lyrics")} className="press flex flex-col items-center gap-1" style={{ color: "#98989D" }}><Mic2 size={18} /><span className="text-[10px]">Lyrics</span></button>
                  <button onClick={() => { setShowSleep((s) => !s); setShowEq(false); }} className="press flex flex-col items-center gap-1" style={{ color: sleepEndsAt ? "#FA2D48" : "#98989D" }}><Moon size={18} /><span className="text-[10px]">{sleepRemaining != null ? fmtTime(sleepRemaining / 1000) : "Sleep"}</span></button>
                  <button onClick={() => { setShowEq((s) => !s); setShowSleep(false); }} className="press flex flex-col items-center gap-1" style={{ color: showEq || eqBands.bass || eqBands.mid || eqBands.treble ? "#FA2D48" : "#98989D" }}><SlidersHorizontal size={18} /><span className="text-[10px]">EQ</span></button>
                  <button onClick={() => setNpView("queue")} className="press flex flex-col items-center gap-1" style={{ color: "#98989D" }}><ListMusic size={18} /><span className="text-[10px]">Up Next</span></button>
                </div>

                {showEq && (
                  <div className="flex items-end gap-6 px-6 py-4 rounded-xl" style={{ background: "rgba(28,28,30,0.9)" }}>
                    {[["bass", "BASS"], ["mid", "MID"], ["treble", "TREB"]].map(([key, label]) => (
                      <div key={key} className="flex flex-col items-center gap-2">
                        <span className="text-xs" style={{ color: "#FA2D48" }}>{eqBands[key] > 0 ? `+${eqBands[key]}` : eqBands[key]}</span>
                        <input type="range" className="vert" min={-12} max={12} step={1} value={eqBands[key]} onChange={(e) => setEqBands((b) => ({ ...b, [key]: Number(e.target.value) }))} />
                        <span className="text-xs tracking-widest" style={{ color: "#98989D" }}>{label}</span>
                      </div>
                    ))}
                  </div>
                )}
                {showSleep && (
                  <div className="rounded-xl py-1 w-40" style={{ background: "rgba(28,28,30,0.95)" }}>
                    {[15, 30, 45, 60].map((m) => (<button key={m} onClick={() => setSleepMinutes(m)} className="block w-full text-left px-4 py-2 text-xs">{m} minutes</button>))}
                    <button onClick={() => setSleepMinutes(0)} className="block w-full text-left px-4 py-2 text-xs" style={{ color: "#FF453A" }}>Turn off</button>
                  </div>
                )}
              </div>
            )}

            {npView === "queue" && (
              <div className="flex-1 overflow-y-auto px-2">
                <div className="flex items-center justify-between px-3 py-2">
                  <button onClick={() => setNpView("player")} className="press flex items-center gap-1 text-sm font-medium"><ChevronDown size={17} /> Back</button>
                  <span className="text-xs tracking-widest" style={{ color: "#98989D" }}>UP NEXT · drag to reorder</span>
                </div>
                {queue.map((id, i) => {
                  const t = library.find((tt) => tt.id === id);
                  if (!t) return null;
                  return (
                    <div key={i} draggable onDragStart={() => setRowDragIdx(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { reorderQueue(rowDragIdx, i); setRowDragIdx(null); }}
                      className="flex items-center gap-3 px-3 py-2.5" style={{ background: i === queueIndex ? "rgba(250,45,72,0.12)" : "transparent", borderRadius: 10 }}>
                      <GripVertical size={14} color="#5A5A5C" />
                      <ArtBox track={t} className="w-9 h-9 rounded-md shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate" style={{ color: i === queueIndex ? "#FA2D48" : "#FFFFFF" }}>{t.name}</div>
                        <div className="text-xs" style={{ color: "#98989D" }}>{t.ext}</div>
                      </div>
                      {i !== queueIndex && <button onClick={() => removeFromQueue(i)} className="press p-1.5" style={{ color: "#7A3A22" }}><X size={15} /></button>}
                    </div>
                  );
                })}
              </div>
            )}

            {npView === "lyrics" && (
              <LyricsPanel track={currentTrack} text={lyricsMap[currentTrack.id] || ""} onSave={(text) => setLyricsMap((prev) => ({ ...prev, [currentTrack.id]: text }))} onBack={() => setNpView("player")} />
            )}
          </div>
        </div>
      )}

      {contextTrackId && (
        <BottomSheetBackdrop onClose={closeContext}>
          <SheetHandle />
          <div className="px-5 pb-1 text-sm font-semibold truncate">{library.find((t) => t.id === contextTrackId)?.name}</div>
          <SheetAction icon={<CornerDownRight size={17} />} label="Play Next" onClick={() => { playNext(contextTrackId); closeContext(); }} />
          <SheetAction icon={<ListPlus size={17} />} label="Play Later" onClick={() => { playLater(contextTrackId); closeContext(); }} />
          <SheetAction icon={<Plus size={17} />} label="Add to Playlist…" onClick={() => { const id = contextTrackId; closeContext(); setAddSheetTrackId(id); }} />
          <SheetAction icon={<Info size={17} />} label="Song Info" onClick={() => { const id = contextTrackId; closeContext(); setInfoSheetTrackId(id); }} />
          {contextInfo?.mode === "playlist" ? (
            <SheetAction icon={<Trash2 size={17} />} label="Remove from Playlist" danger onClick={() => { removeFromPlaylist(contextInfo.playlistId, contextTrackId); closeContext(); }} />
          ) : (
            <SheetAction icon={<Trash2 size={17} />} label="Delete from Library" danger onClick={() => { deleteFromLibrary(contextTrackId); closeContext(); }} />
          )}
        </BottomSheetBackdrop>
      )}

      {addSheetTrackId && (
        <BottomSheetBackdrop onClose={() => setAddSheetTrackId(null)}>
          <SheetHandle />
          <div className="px-5 pb-2 text-sm font-semibold">Add to Playlist</div>
          <div className="max-h-64 overflow-y-auto">
            {playlists.length === 0 ? (
              <div className="px-5 py-4 text-xs" style={{ color: "#98989D" }}>No playlists yet. Create one from the Library tab.</div>
            ) : (
              playlists.map((p) => (<SheetAction key={p.id} icon={<ListMusic size={17} color="#FA2D48" />} label={p.name} sub={`${p.trackIds.length} songs`} onClick={() => addToPlaylist(p.id, addSheetTrackId)} />))
            )}
          </div>
        </BottomSheetBackdrop>
      )}

      {infoSheetTrackId && (() => {
        const t = library.find((tt) => tt.id === infoSheetTrackId);
        if (!t) return null;
        return (
          <BottomSheetBackdrop onClose={() => setInfoSheetTrackId(null)}>
            <SheetHandle />
            <div className="flex items-center gap-3 px-5 pb-4">
              <ArtBox track={t} className="w-14 h-14 rounded-lg shrink-0" />
              <div className="min-w-0"><div className="text-sm font-semibold truncate">{t.name}</div><div className="text-xs" style={{ color: "#98989D" }}>{t.ext}</div></div>
            </div>
            <div className="px-5 pb-6 flex flex-col gap-2 text-xs">
              <InfoRow label="Format" value={t.ext} />
              <InfoRow label="Duration" value={fmtTime(t.duration)} />
              <InfoRow label="Added" value={new Date(t.addedAt).toLocaleDateString()} />
              <InfoRow label="Play Count" value={String(playCounts[t.id] || 0)} />
              <InfoRow label="Album Art" value={t.artUrl ? "Embedded (found in file)" : "Not found — using generated cover"} />
            </div>
          </BottomSheetBackdrop>
        );
      })()}

      {newPlaylistSheet && (
        <BottomSheetBackdrop onClose={() => setNewPlaylistSheet(false)}>
          <SheetHandle />
          <div className="px-5 pb-4">
            <div className="text-sm font-semibold mb-3">New Playlist</div>
            <div className="flex items-center gap-2">
              <input autoFocus value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createPlaylist()} placeholder="Playlist name" className="flex-1 px-3 py-2.5 rounded-lg outline-none text-sm" style={{ background: "#2C2C2E", color: "#FFFFFF" }} />
              <button onClick={createPlaylist} className="press px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: "#FA2D48", color: "#FFFFFF" }}>Create</button>
            </div>
          </div>
        </BottomSheetBackdrop>
      )}

      <audio ref={audioRef} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} onEnded={onEnded} onError={onAudioError} />
    </div>
  );
}

// =====================================================================
function ArtBox({ track, className, children }) {
  return (
    <div className={className} style={{ background: artGradient(track.name), position: "relative", overflow: "hidden" }}>
      {track.artUrl && <img src={track.artUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />}
      {!track.artUrl && children}
    </div>
  );
}

function EmptyState({ dragOver, message }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 px-6 text-center">
      <Upload size={26} color={dragOver ? "#FA2D48" : "#5A5A5C"} />
      <p className="text-sm max-w-xs" style={{ color: "#98989D" }}>{message}</p>
    </div>
  );
}

function HomeRow({ title, icon, tracks, onPlay }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-lg font-bold mb-3">{icon}{title}</div>
      <div className="hscroll pb-2">
        {tracks.map((t, i) => (
          <button key={t.id} onClick={() => onPlay(i)} className="press shrink-0 w-32 text-left">
            <ArtBox track={t} className="w-32 h-32 rounded-xl mb-2" />
            <div className="text-sm font-medium truncate">{t.name}</div>
            <div className="text-xs" style={{ color: "#98989D" }}>{t.ext}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TrackRow({ t, isCurrent, isPlaying, onTap, onMenu, onSwipeDelete }) {
  const [swipeX, setSwipeX] = useState(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const dragging = useRef(false);
  const longPressTimer = useRef(null);
  const suppressTap = useRef(false);

  const onTouchStart = (e) => {
    startX.current = e.touches[0].clientX; startY.current = e.touches[0].clientY;
    dragging.current = false; suppressTap.current = false;
    if (onMenu) longPressTimer.current = setTimeout(() => { suppressTap.current = true; onMenu(); }, 480);
  };
  const onTouchMove = (e) => {
    const dx = e.touches[0].clientX - startX.current, dy = e.touches[0].clientY - startY.current;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(longPressTimer.current);
    if (onSwipeDelete && Math.abs(dx) > Math.abs(dy)) { dragging.current = true; setSwipeX(Math.max(-84, Math.min(0, dx))); }
  };
  const onTouchEnd = () => {
    clearTimeout(longPressTimer.current);
    if (dragging.current) { setSwipeX((x) => (x < -50 ? -84 : 0)); dragging.current = false; return; }
    if (!suppressTap.current) onTap();
  };
  const onContextMenu = (e) => { e.preventDefault(); onMenu && onMenu(); };

  return (
    <div className="relative overflow-hidden" style={{ borderRadius: 12 }}>
      {onSwipeDelete && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center justify-center" style={{ width: 84, background: "#FF453A" }}>
          <button onClick={() => { onSwipeDelete(); setSwipeX(0); }} className="press p-3"><Trash2 size={18} color="#fff" /></button>
        </div>
      )}
      <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onContextMenu={onContextMenu} onClick={() => { if (swipeX === 0) onTap(); }}
        className="flex items-center gap-3 py-2.5" style={{ transform: `translateX(${swipeX}px)`, transition: dragging.current ? "none" : `transform 0.2s ${SPRING}`, background: "#000000" }}>
        <ArtBox track={t} className="w-11 h-11 rounded-lg shrink-0 flex items-center justify-center">
          {isCurrent && isPlaying ? (
            <div className="flex items-end gap-0.5 h-3.5"><div className="eq-bar" style={{ animationDelay: "0s", background: "#fff" }} /><div className="eq-bar" style={{ animationDelay: "0.2s", background: "#fff" }} /><div className="eq-bar" style={{ animationDelay: "0.4s", background: "#fff" }} /></div>
          ) : (<Music size={15} color="rgba(255,255,255,0.6)" />)}
        </ArtBox>
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate" style={{ color: isCurrent ? "#FA2D48" : "#FFFFFF" }}>{t.name}</div>
          <div className="text-xs" style={{ color: "#98989D" }}>{t.ext}{t.duration ? ` · ${fmtTime(t.duration)}` : ""}</div>
        </div>
        {onMenu && <button onClick={(e) => { e.stopPropagation(); onMenu(); }} className="press p-2 shrink-0" style={{ color: "#98989D" }}><MoreHorizontal size={18} /></button>}
      </div>
    </div>
  );
}

function BottomSheetBackdrop({ onClose, children }) {
  return (
    <>
      <div className="absolute inset-0 fade-in" style={{ background: "rgba(0,0,0,0.55)", zIndex: 80 }} onClick={onClose} />
      <div className="sheet-enter absolute left-0 right-0 bottom-0 rounded-t-2xl pb-8 pt-2" style={{ background: "#1C1C1E", zIndex: 81, maxHeight: "70vh", overflowY: "auto" }}>{children}</div>
    </>
  );
}
function SheetHandle() { return <div className="w-9 h-1 rounded-full mx-auto mb-3" style={{ background: "rgba(255,255,255,0.25)" }} />; }
function SheetAction({ icon, label, sub, onClick, danger }) {
  return (
    <button onClick={onClick} className="press w-full flex items-center gap-3 px-5 py-3 text-left">
      <span style={{ color: danger ? "#FF453A" : "#FA2D48" }}>{icon}</span>
      <span className="text-sm flex-1" style={{ color: danger ? "#FF453A" : "#FFFFFF" }}>{label}</span>
      {sub && <span className="text-xs" style={{ color: "#98989D" }}>{sub}</span>}
    </button>
  );
}
function InfoRow({ label, value }) {
  return (<div className="flex items-center justify-between py-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}><span style={{ color: "#98989D" }}>{label}</span><span>{value}</span></div>);
}

function LyricsPanel({ track, text, onSave, onBack }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => { setDraft(text); setEditing(false); }, [track?.id]);
  return (
    <div className="flex-1 flex flex-col px-5 overflow-hidden">
      <div className="flex items-center justify-between py-2">
        <button onClick={onBack} className="press flex items-center gap-1 text-sm font-medium"><ChevronDown size={17} /> Back</button>
        {!editing ? (<button onClick={() => setEditing(true)} className="press text-sm font-medium" style={{ color: "#FA2D48" }}>{text ? "Edit" : "Add Lyrics"}</button>)
          : (<button onClick={() => { onSave(draft); setEditing(false); }} className="press text-sm font-medium" style={{ color: "#FA2D48" }}>Save</button>)}
      </div>
      {editing ? (
        <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste or type lyrics here…" className="flex-1 bg-transparent outline-none text-sm leading-relaxed resize-none" style={{ color: "#FFFFFF" }} />
      ) : (
        <div className="flex-1 overflow-y-auto text-base leading-loose whitespace-pre-wrap" style={{ color: text ? "#FFFFFF" : "#98989D" }}>{text || "No lyrics added yet. Tap \"Add Lyrics\" to write or paste them in."}</div>
      )}
    </div>
  );
}
