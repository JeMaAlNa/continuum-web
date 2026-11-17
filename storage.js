"use strict";
// Audio is stored as immutable byte chunks. Metadata updates never re-save File/Blob handles.
const ContinuumStorage = (() => {
  const chunkSize = 1024 * 1024;
  let connection, opening;
  const error = (name, message) => Object.assign(new Error(message), {name});
  function disconnect() { if (connection) connection.close(); connection = undefined; }
  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    opening = new Promise((resolve,reject) => {
      let finished = false;
      const timer = setTimeout(() => finish(error("StorageTimeout", "Device storage did not respond. Close and reopen Continuum without deleting it.")), 10000);
      const request = indexedDB.open("ContinuumWeb", 2);
      function finish(failure, db) {
        if (finished) { if (db) db.close(); return; }
        finished = true; clearTimeout(timer); opening = undefined;
        if (failure) reject(failure); else { connection = db; resolve(db); }
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks",{keyPath:"id"});
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio",{keyPath:["audioKey","index"]});
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); if (connection === db) connection = undefined; };
        db.onclose = () => { if (connection === db) connection = undefined; };
        finish(null,db);
      };
      request.onerror = () => finish(request.error);
      request.onblocked = () => finish(error("StorageBlocked", "Close other Continuum tabs, then tap Recover playback. Your music is kept."));
    });
    return opening;
  }
  async function transaction(stores, mode, action, retry = true) {
    const db = await open();
    try {
      return await new Promise((resolve,reject) => {
        let tx, result, finished = false;
        const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(error("StorageTimeout","Device storage stopped responding.")); },15000);
        function finish(failure) { if (finished) return; finished = true; clearTimeout(timer); failure ? reject(failure) : resolve(result); }
        try {
          tx = db.transaction(stores,mode);
          tx.oncomplete = () => finish();
          tx.onabort = () => finish(tx.error || error("AbortError","Storage operation stopped."));
          action(tx, value => { result = value; });
        } catch (failure) { try { tx?.abort(); } catch {} finish(failure); }
      });
    } catch (failure) {
      if (retry && ["InvalidStateError","UnknownError","StorageTimeout","AbortError"].includes(failure.name)) {
        disconnect(); return transaction(stores,mode,action,false);
      }
      throw failure;
    }
  }
  const get = (store,key) => transaction([store],"readonly",(tx,result) => {
    const request = tx.objectStore(store).get(key); request.onsuccess = () => result(request.result);
  });
  const put = (store,record) => transaction([store],"readwrite",tx => tx.objectStore(store).put(record));
  function contentType(name, supplied) {
    if (supplied && supplied !== "application/octet-stream") return supplied;
    return ({mp3:"audio/mpeg",m4a:"audio/mp4",aac:"audio/aac",wav:"audio/wav",flac:"audio/flac",ogg:"audio/ogg",opus:"audio/ogg",aiff:"audio/aiff",aif:"audio/aiff"})[String(name).split('.').pop().toLowerCase()] || supplied || "application/octet-stream";
  }
  class StoredFile {
    constructor(record) { this.descriptor = record; this.name = record.name; this.type = record.type; this.size = record.size; this.isStoredAudio = true; }
    slice(from=0,to=this.size,type="") {
      const size = this.size;
      const normalize = n => n < 0 ? Math.max(size+n,0) : Math.min(n,size);
      const start = normalize(from), end = Math.max(start,normalize(to));
      return {size:end-start,type,arrayBuffer:() => readRange(this.descriptor,start,end)};
    }
    arrayBuffer() { return readRange(this.descriptor,0,this.size); }
  }
  async function readRange(record,start,end) {
    const result = new Uint8Array(end-start);
    for (let index = Math.floor(start/chunkSize); index*chunkSize < end; index++) {
      const chunk = await get("audio",[record.audioKey,index]);
      if (!chunk || !(chunk.bytes instanceof ArrayBuffer) || chunk.bytes.byteLength !== Math.min(chunkSize,record.size-index*chunkSize)) throw error("MissingAudio","Some saved audio is missing. Repair the song from Files; your playlist can be kept.");
      const offset = index*chunkSize, left = Math.max(start,offset), right = Math.min(end,offset+chunk.bytes.byteLength);
      if (right <= left) throw error("MissingAudio","Saved audio is incomplete.");
      result.set(new Uint8Array(chunk.bytes,left-offset,right-left),left-start);
    }
    return result.buffer;
  }
  function hydrate(record) {
    if (record.audio?.audioKey) return {...record,file:new StoredFile(record.audio)};
    return record; // v8 legacy File is kept until its bytes have been safely copied.
  }
  async function list() {
    const rows = await transaction(["tracks"],"readonly",(tx,result) => {
      const request = tx.objectStore("tracks").getAll(); request.onsuccess = () => result(request.result);
    });
    return rows.map(hydrate);
  }
  let writeQueue = Promise.resolve();
  function write(operations) {
    const task = writeQueue.then(async () => {
      const prepared = [], staged = [];
      let metadataStarted = false;
      try {
        for (const operation of operations) {
          if (operation.kind === "patch") { prepared.push(operation); continue; }
          const track = operation.track, file = track.file;
          let audio = file?.isStoredAudio ? file.descriptor : track.audio;
          // A supplied replacement File must replace the old bytes too.
          if (file && !file.isStoredAudio) {
            audio = {audioKey:crypto.randomUUID ? crypto.randomUUID() : Date.now()+"-"+Math.random(),name:file.name || track.title+".audio",type:contentType(file.name,file.type),size:file.size};
            audio.stagedChunks = 0;
            staged.push(audio);
            if (!audio.size) throw error("MissingAudio","This song contains no audio.");
            for (let index = 0; index*chunkSize < file.size; index++) {
              const bytes = await file.slice(index*chunkSize,Math.min(file.size,(index+1)*chunkSize)).arrayBuffer();
              if (bytes.byteLength !== Math.min(chunkSize,file.size-index*chunkSize)) throw error("MissingAudio","The selected file could not be read completely.");
              await put("audio",{audioKey:audio.audioKey,index,bytes});
              audio.stagedChunks++;
            }
          }
          if (!audio) throw error("MissingAudio","No readable audio was found.");
          const {file:ignored,...metadata} = track;
          prepared.push({...operation,record:{...metadata,audio}});
        }
        metadataStarted = true;
        await transaction(["tracks"],"readwrite",tx => {
          const store = tx.objectStore("tracks");
          for (const op of prepared) {
            if (op.kind === "patch") {
              const request = store.get(op.id);
              request.onsuccess = () => { if (request.result) store.put({...request.result,...op.patch}); };
            } else store[op.kind](op.record);
          }
        },false); // Do not replay add() after an ambiguous commit.
        for (const op of prepared) if (op.track) {
          op.track.audio = op.record.audio; op.track.file = new StoredFile(op.record.audio);
        }
        return prepared.filter(op => op.track).map(op => op.track);
      } catch (failure) {
        // Before a metadata transaction starts, staged keys cannot belong to a saved song.
        if (!metadataStarted) {
          for (const audio of staged) {
            try { await transaction(["audio"],"readwrite",tx => {
              for (let index=0;index<audio.stagedChunks;index++) tx.objectStore("audio").delete([audio.audioKey,index]);
            }); } catch {}
          }
        }
        // On an ambiguous metadata commit retain staged bytes rather than risk data loss.
        throw failure;
      }
    });
    writeQueue = task.catch(() => {}); return task;
  }
  async function materialize(file) {
    const bytes = await file.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength !== file.size) throw error("MissingAudio","Saved audio is incomplete.");
    return new File([bytes],file.name || "audio",{type:contentType(file.name,file.type)});
  }
  return {open,disconnect,list,get,write,readRange,materialize,contentType,chunkSize};
})();
