import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { importCellImage, readCellImage } from "./ipc";
import type { CellImage, CellInfo } from "./types";

export default function ImagePreview({ info, documentId, readOnly, onClose, onSave, onError }: {
  info: CellInfo; documentId: number; readOnly?: boolean;
  onClose: () => void; onSave: (image: CellImage | null) => Promise<void>; onError: (message: string) => void;
}) {
  const image = info.image!;
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [alt, setAlt] = useState(image.alt);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let stale = false, resource = "";
    void readCellImage(documentId, image.assetId, false).then(bytes => {
      if (stale) return;
      resource = URL.createObjectURL(new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)]));
      setUrl(resource);
    }).catch(reason => { if (!stale) setError(String(reason)); });
    return () => { stale = true; if (resource) URL.revokeObjectURL(resource); };
  }, [documentId, image.assetId]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (reason) { setError(String(reason)); onError(String(reason)); } finally { setBusy(false); }
  };
  return <dialog className="image-preview" ref={dialog} aria-labelledby="image-preview-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="image-preview-title">{image.name}</h2>
    {error ? <p role="alert">{error}</p> : url ? <img src={url} alt={alt || image.name} onError={() => setError("Image could not be displayed")} /> : <p role="status">Loading image…</p>}
    <label>Alternative text<input value={alt} maxLength={8192} disabled={readOnly || busy} onChange={event => setAlt(event.target.value)} /></label>
    <div className="image-preview-actions">
      <button disabled={busy} onClick={onClose}>Close</button>
      <button disabled={readOnly || busy} onClick={() => void run(async () => {
        const path = await open({ title: "Replace image", multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] });
        if (typeof path === "string") await onSave(await importCellImage(documentId, path));
      })}>Replace image…</button>
      <button disabled={readOnly || busy} onClick={() => void run(() => onSave(null))}>Remove image</button>
      <button disabled={readOnly || busy || alt === image.alt} onClick={() => void run(() => onSave({ ...image, alt }))}>Save alternative text</button>
    </div>
  </dialog>;
}
