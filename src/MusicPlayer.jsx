import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  Upload, Plus, Trash2, Music, ListMusic, Volume2, VolumeX, X, Disc3,
  Search, SlidersHorizontal, Moon, GripVertical
} from "lucide-react";

// ---- helpers ----------------------------------------------------------
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

const uid = () => Math.random().toString(36).slice(2, 10);

let decodeCtx = null;
const getDecodeCtx = () => {
  if (!decodeCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new AC();
  }
  return decodeCtx;
};

// Decode a file into a small peaks array for waveform drawing.
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

export default function MusicPlayer() {
  // ---- library / playlists (in-memory only — see footer note) --------
  const [library, setLibrary] = useState([]); // {id, name, ext, url, peaks, duration, file}
  const [playlists, setPlaylists] = useState([]); // {id, name, trackIds:[]}
  const [activeListId, setActiveListId] = useState("library");
  const [queueTrackId, setQueueTrackId] = useState(null);

  // ---- transport state -------------------------------------------------
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState("off"); // off | all | one

  // ---- ui state ---------------------------------------------------------
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [addMenuTrackId, setAddMenuTrackId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showEq, setShowEq] = useState(false);
  const [eqBands, setEqBands] = useState({ bass: 0, mid: 0, treble: 0 });
  const [showSleep, setShowSleep] = useState(false);
  const [sleepEndsAt, setSleepEndsAt] = useState(null);
  const [sleepRemaining, setSleepRemaining] = useState(null);
  const [dragTrackIdx, setDragTrackIdx] = useState(null);

  // ---- refs ---------------------------------------------------------
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const vuCanvasRef = useRef(null);
  const waveCanvasRef = useRef(null);
  const waveWrapRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const eqRefs = useRef({});
  const rafRef = useRef(null);
  const sleepTimeoutRef = useRef(null);

  const listSource =
    activeListId === "library"
      ? library
      : (playlists.find((p) => p.id === activeListId)?.trackIds || [])
          .map((tid) => library.find((t) => t.id === tid))
          .filter(Boolean);

  const currentList = searchQuery.trim()
    ? listSource.filter((t) => t.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : listSource;

  const currentTrack = library.find((t) => t.id === queueTrackId) || null;

  // ------------------------------------------------------------------
  // Web Audio graph: source -> bass -> mid -> treble -> analyser -> out
  // ------------------------------------------------------------------
  const ensureAudioGraph = useCallback(() => {
    if (!audioRef.current || audioCtxRef.current) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaElementSource(audioRef.current);

    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 200;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 1;

    const treble = ctx.createBiquadFilter();
    treble.type = "highshelf";
    treble.frequency.value = 3000;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;

    source.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(analyser);
    analyser.connect(ctx.destination);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    sourceNodeRef.current = source;
    eqRefs.current = { bass, mid, treble };
  }, []);

  useEffect(() => {
    const { bass, mid, treble } = eqRefs.current;
    if (bass) bass.gain.value = eqBands.bass;
    if (mid) mid.gain.value = eqBands.mid;
    if (treble) treble.gain.value = eqBands.treble;
  }, [eqBands]);

  // ------------------------------------------------------------------
  // Drawing loop: VU meter + waveform, one shared rAF
  // ------------------------------------------------------------------
  useEffect(() => {
    const draw = () => {
      // VU meter
      const vu = vuCanvasRef.current;
      if (vu) {
        const c = vu.getContext("2d");
        const w = vu.width, h = vu.height;
        c.clearRect(0, 0, w, h);
        const bars = 20, gap = 3;
        const barW = (w - gap * (bars - 1)) / bars;
        let data = null;
        if (analyserRef.current && isPlaying) {
          data = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(data);
        }
        for (let i = 0; i < bars; i++) {
          let level = 0;
          if (data) level = data[Math.floor((i / bars) * data.length)] / 255;
          const barH = Math.max(2, level * h);
          c.fillStyle = level > 0.82 ? "#B5451B" : "#C9A227";
          c.fillRect(i * (barW + gap), h - barH, barW, barH);
        }
      }

      // Waveform
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
            const x = i * barW;
            const y = (h - barH) / 2;
            const played = i / peaks.length < progressRatio;
            c.fillStyle = played ? "#C9A227" : "#3A342A";
            c.fillRect(x, y, Math.max(1, barW - 1), barH);
          });
        } else {
          // fallback: simple progress line
          c.fillStyle = "#3A342A";
          c.fillRect(0, h / 2 - 1, w, 2);
          c.fillStyle = "#C9A227";
          c.fillRect(0, h / 2 - 1, w * progressRatio, 2);
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, currentTrack, currentTime, duration]);

  // keep waveform canvas crisp / responsive
  useEffect(() => {
    const resize = () => {
      if (waveCanvasRef.current && waveWrapRef.current) {
        waveCanvasRef.current.width = waveWrapRef.current.clientWidth;
        waveCanvasRef.current.height = 40;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // ------------------------------------------------------------------
  // File import
  // ------------------------------------------------------------------
  const importFiles = async (fileList) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("audio/"));
    if (files.length === 0) return;
    const drafts = files.map((f) => ({
      id: uid(),
      name: f.name.replace(/\.[^/.]+$/, ""),
      ext: f.name.split(".").pop().toUpperCase(),
      url: URL.createObjectURL(f),
      duration: 0,
      peaks: null,
      file: f,
    }));
    setLibrary((prev) => [...prev, ...drafts]);
    // decode waveforms in the background, one by one
    for (const d of drafts) {
      const { peaks, duration } = await computePeaks(d.file);
      setLibrary((prev) =>
        prev.map((t) => (t.id === d.id ? { ...t, peaks, duration: duration || t.duration } : t))
      );
    }
  };

  const onFileInputChange = (e) => {
    if (e.target.files?.length) importFiles(e.target.files);
    e.target.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) importFiles(e.dataTransfer.files);
  };

  // ------------------------------------------------------------------
  // Playback control
  // ------------------------------------------------------------------
  const loadTrack = (track, autoplay = true) => {
    if (!track) return;
    setQueueTrackId(track.id);
    setCurrentTime(0);
    requestAnimationFrame(() => {
      ensureAudioGraph();
      if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
      if (audioRef.current) {
        audioRef.current.src = track.url;
        if (autoplay) {
          audioRef.current.play().catch(() => {});
          setIsPlaying(true);
        }
      }
    });
  };

  const playTrackFromList = (track) => {
    if (track.id === queueTrackId) togglePlay();
    else loadTrack(track, true);
  };

  const togglePlay = () => {
    if (!audioRef.current || !currentTrack) {
      if (currentList.length) loadTrack(currentList[0], true);
      return;
    }
    ensureAudioGraph();
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const stepTrack = (dir) => {
    if (!currentList.length) return;
    let idx = currentList.findIndex((t) => t.id === queueTrackId);
    if (idx === -1) idx = 0;
    if (shuffle) {
      let next = Math.floor(Math.random() * currentList.length);
      if (currentList.length > 1) {
        while (next === idx) next = Math.floor(Math.random() * currentList.length);
      }
      loadTrack(currentList[next], true);
      return;
    }
    let next = idx + dir;
    if (next < 0) next = currentList.length - 1;
    if (next >= currentList.length) next = 0;
    loadTrack(currentList[next], true);
  };

  const onEnded = () => {
    if (repeatMode === "one") {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    const idx = currentList.findIndex((t) => t.id === queueTrackId);
    const isLast = idx === currentList.length - 1;
    if (isLast && repeatMode === "off" && !shuffle) {
      setIsPlaying(false);
      return;
    }
    stepTrack(1);
  };

  const cycleRepeat = () => {
    setRepeatMode((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"));
  };

  const seekTo = (t) => {
    if (!audioRef.current) return;
    const clamped = Math.max(0, Math.min(duration || 0, t));
    audioRef.current.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const onWaveClick = (e) => {
    if (!waveCanvasRef.current || !duration) return;
    const rect = waveCanvasRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekTo(ratio * duration);
  };

  const onVolumeChange = (e) => {
    const v = Number(e.target.value);
    setVolume(v);
    setMuted(false);
    if (audioRef.current) audioRef.current.volume = v;
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  // ------------------------------------------------------------------
  // Keyboard shortcuts
  // ------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          seekTo(currentTime + 5);
          break;
        case "ArrowLeft":
          seekTo(currentTime - 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume((v) => Math.min(1, v + 0.05));
          setMuted(false);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume((v) => Math.max(0, v - 0.05));
          setMuted(false);
          break;
        case "n":
        case "N":
          stepTrack(1);
          break;
        case "p":
        case "P":
          stepTrack(-1);
          break;
        case "m":
        case "M":
          setMuted((m) => !m);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ------------------------------------------------------------------
  // Sleep timer
  // ------------------------------------------------------------------
  const setSleepMinutes = (mins) => {
    clearTimeout(sleepTimeoutRef.current);
    if (!mins) {
      setSleepEndsAt(null);
      setSleepRemaining(null);
      setShowSleep(false);
      return;
    }
    const end = Date.now() + mins * 60000;
    setSleepEndsAt(end);
    setShowSleep(false);
    sleepTimeoutRef.current = setTimeout(() => {
      if (audioRef.current) audioRef.current.pause();
      setIsPlaying(false);
      setSleepEndsAt(null);
      setSleepRemaining(null);
    }, mins * 60000);
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
  // Playlist management
  // ------------------------------------------------------------------
  const createPlaylist = () => {
    const name = newPlaylistName.trim();
    if (!name) return;
    const pl = { id: uid(), name, trackIds: [] };
    setPlaylists((prev) => [...prev, pl]);
    setNewPlaylistName("");
    setShowNewPlaylist(false);
    setActiveListId(pl.id);
  };

  const deletePlaylist = (id) => {
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    if (activeListId === id) setActiveListId("library");
  };

  const addToPlaylist = (playlistId, trackId) => {
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === playlistId && !p.trackIds.includes(trackId)
          ? { ...p, trackIds: [...p.trackIds, trackId] }
          : p
      )
    );
    setAddMenuTrackId(null);
  };

  const removeFromPlaylist = (playlistId, trackId) => {
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === playlistId ? { ...p, trackIds: p.trackIds.filter((t) => t !== trackId) } : p
      )
    );
  };

  const deleteFromLibrary = (trackId) => {
    setLibrary((prev) => prev.filter((t) => t.id !== trackId));
    setPlaylists((prev) =>
      prev.map((p) => ({ ...p, trackIds: p.trackIds.filter((t) => t !== trackId) }))
    );
    if (queueTrackId === trackId) {
      setQueueTrackId(null);
      setIsPlaying(false);
    }
  };

  const reorderPlaylist = (fromIdx, toIdx) => {
    if (activeListId === "library" || fromIdx === toIdx || fromIdx == null) return;
    setPlaylists((prev) =>
      prev.map((p) => {
        if (p.id !== activeListId) return p;
        const ids = [...p.trackIds];
        const [moved] = ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, moved);
        return { ...p, trackIds: ids };
      })
    );
  };

  const activePlaylist = playlists.find((p) => p.id === activeListId);
  const canReorder = activeListId !== "library" && !searchQuery.trim();

  // ------------------------------------------------------------------
  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{ background: "#14120F", color: "#EDE3D3", fontFamily: "'IBM Plex Mono', monospace" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .disp { font-family: 'Oswald', sans-serif; letter-spacing: 0.02em; }
        input[type="range"] {
          -webkit-appearance: none; appearance: none;
          height: 3px; background: #3A342A; border-radius: 999px; outline: none;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 12px; height: 12px; border-radius: 50%;
          background: #C9A227; cursor: pointer; border: 2px solid #14120F;
        }
        input[type="range"]::-moz-range-thumb {
          width: 12px; height: 12px; border-radius: 50%;
          background: #C9A227; cursor: pointer; border: 2px solid #14120F;
        }
        input[type="range"].vert {
          writing-mode: vertical-lr; direction: rtl;
          width: 4px; height: 80px;
        }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #14120F; }
        ::-webkit-scrollbar-thumb { background: #3A342A; border-radius: 4px; }
      `}</style>

      {/* header */}
      <header className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "#2A2620" }}>
        <div className="flex items-center gap-3">
          <Disc3 size={26} color="#C9A227" className={isPlaying ? "animate-spin" : ""} style={{ animationDuration: "3s" }} />
          <h1 className="disp text-xl font-semibold tracking-wide">SPOOL</h1>
          <span className="text-xs" style={{ color: "#6B6355" }}>lossless local player</span>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-sm" style={{ background: "#1F1B15", border: "1px solid #3A342A" }}>
            <Search size={13} color="#6B6355" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tracks…"
              className="bg-transparent outline-none text-xs w-32"
              style={{ color: "#EDE3D3" }}
            />
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-sm"
            style={{ background: "#1F1B15", color: "#C9A227", border: "1px solid #3A342A" }}
          >
            <Upload size={14} /> IMPORT
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="audio/*" multiple onChange={onFileInputChange} className="hidden" />
      </header>

      {/* body */}
      <div className="flex flex-1 overflow-hidden">
        {/* sidebar */}
        <aside className="w-60 shrink-0 border-r flex flex-col" style={{ borderColor: "#2A2620" }}>
          <nav className="p-3 flex flex-col gap-1 overflow-y-auto">
            <button
              onClick={() => setActiveListId("library")}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-sm text-left"
              style={{ background: activeListId === "library" ? "#241F17" : "transparent", color: activeListId === "library" ? "#C9A227" : "#EDE3D3" }}
            >
              <Music size={15} /> All Tracks
              <span className="ml-auto text-xs" style={{ color: "#6B6355" }}>{library.length}</span>
            </button>

            <div className="mt-4 mb-1 px-3 text-xs tracking-widest" style={{ color: "#6B6355" }}>PLAYLISTS</div>

            {playlists.map((p) => (
              <div key={p.id} className="group flex items-center gap-2 px-3 py-2 text-sm rounded-sm"
                style={{ background: activeListId === p.id ? "#241F17" : "transparent", color: activeListId === p.id ? "#C9A227" : "#EDE3D3" }}>
                <button onClick={() => setActiveListId(p.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                  <ListMusic size={15} className="shrink-0" />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-xs shrink-0" style={{ color: "#6B6355" }}>{p.trackIds.length}</span>
                </button>
                <button onClick={() => deletePlaylist(p.id)} className="opacity-0 group-hover:opacity-100 shrink-0" style={{ color: "#B5451B" }} title="Delete playlist">
                  <X size={13} />
                </button>
              </div>
            ))}

            {showNewPlaylist ? (
              <div className="flex items-center gap-1 px-1 mt-1">
                <input
                  autoFocus
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createPlaylist()}
                  placeholder="Playlist name"
                  className="flex-1 px-2 py-1.5 text-sm rounded-sm outline-none"
                  style={{ background: "#1F1B15", color: "#EDE3D3", border: "1px solid #3A342A" }}
                />
                <button onClick={createPlaylist} style={{ color: "#C9A227" }}><Plus size={16} /></button>
              </div>
            ) : (
              <button onClick={() => setShowNewPlaylist(true)} className="flex items-center gap-2 px-3 py-2 mt-1 text-sm rounded-sm" style={{ color: "#6B6355" }}>
                <Plus size={15} /> New Playlist
              </button>
            )}
          </nav>
        </aside>

        {/* main */}
        <main className="flex-1 overflow-y-auto p-6" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="disp text-2xl">{activeListId === "library" ? "All Tracks" : activePlaylist?.name}</h2>
            <span className="text-xs" style={{ color: "#6B6355" }}>
              {currentList.length} track{currentList.length !== 1 ? "s" : ""}
              {canReorder && currentList.length > 1 ? " · drag to reorder" : ""}
            </span>
          </div>

          {currentList.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md py-20 text-center"
              style={{ border: `1px dashed ${dragOver ? "#C9A227" : "#3A342A"}`, background: dragOver ? "#1C1811" : "transparent" }}>
              <Upload size={28} color="#6B6355" />
              <p style={{ color: "#6B6355" }} className="text-sm max-w-xs">
                {searchQuery
                  ? "No tracks match your search."
                  : activeListId === "library"
                  ? "Drag audio files here, or use Import above. Files play at their original quality — nothing is re-encoded."
                  : "This playlist is empty. Add tracks from All Tracks."}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ color: "#6B6355" }} className="text-left text-xs tracking-widest">
                  <th className="pb-2 pl-2 w-8">#</th>
                  <th className="pb-2">TITLE</th>
                  <th className="pb-2 w-16">FMT</th>
                  <th className="pb-2 w-10"></th>
                  <th className="pb-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {currentList.map((t, i) => {
                  const isCurrent = t.id === queueTrackId;
                  return (
                    <tr
                      key={t.id}
                      draggable={canReorder}
                      onDragStart={() => setDragTrackIdx(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { reorderPlaylist(dragTrackIdx, i); setDragTrackIdx(null); }}
                      onDoubleClick={() => playTrackFromList(t)}
                      className="group cursor-pointer"
                      style={{ background: isCurrent ? "#1C1811" : "transparent", borderTop: "1px solid #201C16" }}
                    >
                      <td className="py-2.5 pl-2" style={{ color: isCurrent ? "#C9A227" : "#6B6355" }}>
                        <div className="flex items-center gap-1.5">
                          {canReorder && (
                            <GripVertical size={12} className="opacity-0 group-hover:opacity-60 cursor-grab shrink-0" />
                          )}
                          {isCurrent && isPlaying ? (
                            <Pause size={13} onClick={() => togglePlay()} />
                          ) : (
                            <span onClick={() => playTrackFromList(t)}>{isCurrent ? <Play size={13} /> : i + 1}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 truncate max-w-xs" style={{ color: isCurrent ? "#C9A227" : "#EDE3D3" }} onClick={() => playTrackFromList(t)}>
                        {t.name}
                      </td>
                      <td className="py-2.5 text-xs" style={{ color: "#6B6355" }}>{t.ext}</td>
                      <td className="py-2.5 relative">
                        <button onClick={() => setAddMenuTrackId(addMenuTrackId === t.id ? null : t.id)} className="opacity-0 group-hover:opacity-100" style={{ color: "#6B6355" }} title="Add to playlist">
                          <Plus size={15} />
                        </button>
                        {addMenuTrackId === t.id && (
                          <div className="absolute right-0 top-6 z-10 rounded-sm shadow-lg py-1 w-44" style={{ background: "#1F1B15", border: "1px solid #3A342A" }}>
                            {playlists.length === 0 ? (
                              <div className="px-3 py-2 text-xs" style={{ color: "#6B6355" }}>No playlists yet</div>
                            ) : (
                              playlists.map((p) => (
                                <button key={p.id} onClick={() => addToPlaylist(p.id, t.id)} className="block w-full text-left px-3 py-1.5 text-xs" style={{ color: "#EDE3D3" }}>
                                  {p.name}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5">
                        <button
                          onClick={() => (activeListId === "library" ? deleteFromLibrary(t.id) : removeFromPlaylist(activeListId, t.id))}
                          className="opacity-0 group-hover:opacity-100" style={{ color: "#B5451B" }}
                          title={activeListId === "library" ? "Remove from library" : "Remove from playlist"}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </main>
      </div>

      {/* transport bar */}
      <footer className="border-t px-6 py-3 flex flex-col gap-2 relative" style={{ borderColor: "#2A2620", background: "#17140F" }}>
        {showEq && (
          <div className="absolute bottom-full right-24 mb-2 flex items-end gap-5 px-5 py-4 rounded-sm shadow-xl" style={{ background: "#1F1B15", border: "1px solid #3A342A" }}>
            {[["bass", "BASS"], ["mid", "MID"], ["treble", "TREB"]].map(([key, label]) => (
              <div key={key} className="flex flex-col items-center gap-2">
                <span className="text-xs" style={{ color: "#C9A227" }}>{eqBands[key] > 0 ? `+${eqBands[key]}` : eqBands[key]}</span>
                <input
                  type="range" className="vert" min={-12} max={12} step={1}
                  value={eqBands[key]}
                  onChange={(e) => setEqBands((b) => ({ ...b, [key]: Number(e.target.value) }))}
                />
                <span className="text-xs tracking-widest" style={{ color: "#6B6355" }}>{label}</span>
              </div>
            ))}
          </div>
        )}

        {showSleep && (
          <div className="absolute bottom-full right-6 mb-2 rounded-sm shadow-xl py-1 w-36" style={{ background: "#1F1B15", border: "1px solid #3A342A" }}>
            {[15, 30, 45, 60].map((m) => (
              <button key={m} onClick={() => setSleepMinutes(m)} className="block w-full text-left px-3 py-1.5 text-xs" style={{ color: "#EDE3D3" }}>
                {m} minutes
              </button>
            ))}
            <button onClick={() => setSleepMinutes(0)} className="block w-full text-left px-3 py-1.5 text-xs" style={{ color: "#B5451B" }}>
              Turn off
            </button>
          </div>
        )}

        {/* waveform scrubber row */}
        <div className="flex items-center gap-3">
          <span className="disp text-xs tracking-widest w-10 text-right" style={{ color: "#C9A227" }}>{fmtTime(currentTime)}</span>
          <div ref={waveWrapRef} className="flex-1 h-10 cursor-pointer">
            <canvas ref={waveCanvasRef} height={40} onClick={onWaveClick} className="w-full h-full" />
          </div>
          <span className="disp text-xs tracking-widest w-10" style={{ color: "#6B6355" }}>{fmtTime(duration)}</span>
        </div>

        <div className="flex items-center gap-5">
          <canvas ref={vuCanvasRef} width={90} height={28} className="shrink-0" />

          <div className="flex flex-col min-w-0 w-40 shrink-0">
            <span className="text-sm truncate" style={{ color: currentTrack ? "#EDE3D3" : "#6B6355" }}>
              {currentTrack ? currentTrack.name : "No track loaded"}
            </span>
            {currentTrack && <span className="text-xs" style={{ color: "#6B6355" }}>{currentTrack.ext} · lossless passthrough</span>}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => setShuffle((s) => !s)} style={{ color: shuffle ? "#C9A227" : "#6B6355" }}><Shuffle size={16} /></button>
            <button onClick={() => stepTrack(-1)} style={{ color: "#EDE3D3" }}><SkipBack size={18} /></button>
            <button onClick={togglePlay} className="flex items-center justify-center w-9 h-9 rounded-full" style={{ background: "#C9A227", color: "#14120F" }}>
              {isPlaying ? <Pause size={17} /> : <Play size={17} style={{ marginLeft: 2 }} />}
            </button>
            <button onClick={() => stepTrack(1)} style={{ color: "#EDE3D3" }}><SkipForward size={18} /></button>
            <button onClick={cycleRepeat} style={{ color: repeatMode !== "off" ? "#C9A227" : "#6B6355" }}>
              {repeatMode === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
            </button>
          </div>

          <div className="flex-1" />

          <button onClick={() => { setShowSleep((s) => !s); setShowEq(false); }} className="flex items-center gap-1.5 text-xs shrink-0" style={{ color: sleepEndsAt ? "#C9A227" : "#6B6355" }} title="Sleep timer">
            <Moon size={15} />
            {sleepRemaining != null && fmtTime(sleepRemaining / 1000)}
          </button>

          <button onClick={() => { setShowEq((s) => !s); setShowSleep(false); }} className="shrink-0" style={{ color: showEq || eqBands.bass || eqBands.mid || eqBands.treble ? "#C9A227" : "#6B6355" }} title="Equalizer">
            <SlidersHorizontal size={16} />
          </button>

          <div className="flex items-center gap-2 w-28 shrink-0">
            <button onClick={() => setMuted((m) => !m)} style={{ color: "#6B6355" }}>
              {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={onVolumeChange} className="flex-1" />
          </div>
        </div>
      </footer>

      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.target.duration)}
        onEnded={onEnded}
      />
    </div>
  );
}
