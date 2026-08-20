/** Isolated static-preview hosting and review runtime for the DPBT workflow. */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DesignFeedback } from "./types.js";
import { ensureDirectory } from "./util.js";

const SERVER_FILE = "design-review-server.mjs";
const SERVER_STATE_FILE = "design-review-server.json";
const FEEDBACK_FILE = "feedback.json";
const REVIEW_FILE = "review.json";
const APPROVAL_FILE = "approval.json";

export function initializeDesignReview(previewDir: string): void {
	ensureDirectory(previewDir);
	if (!fs.existsSync(path.join(previewDir, FEEDBACK_FILE))) fs.writeFileSync(path.join(previewDir, FEEDBACK_FILE), "[]\n");
	if (!fs.existsSync(path.join(previewDir, REVIEW_FILE))) fs.writeFileSync(path.join(previewDir, REVIEW_FILE), JSON.stringify({ action: "awaiting-review" }, null, 2));
	installReviewRuntime(previewDir);
}

/** Ensure a designer-authored document loads the review-only overlay assets. */
export function attachDesignReviewAssets(previewDir: string): void {
	const indexPath = path.join(previewDir, "index.html");
	if (!fs.existsSync(indexPath)) throw new Error(`Designer did not create ${indexPath}`);
	let html = fs.readFileSync(indexPath, "utf8");
	if (!html.includes("dpbt-review.css")) {
		const tag = '  <link rel="stylesheet" href="./dpbt-review.css">';
		html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}\n</head>`) : `${tag}\n${html}`;
	}
	if (!html.includes("dpbt-review.js")) {
		const tag = '  <script src="./dpbt-review.js"></script>';
		html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}\n</body>`) : `${html}\n${tag}`;
	}
	fs.writeFileSync(indexPath, html);
}

export function resetReviewRequest(previewDir: string): void {
	fs.writeFileSync(path.join(previewDir, REVIEW_FILE), JSON.stringify({ action: "awaiting-review", updatedAt: Date.now() }, null, 2));
	try { fs.unlinkSync(path.join(previewDir, APPROVAL_FILE)); } catch { /* no prior approval */ }
}

export function readDesignFeedback(previewDir: string): DesignFeedback[] {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(previewDir, FEEDBACK_FILE), "utf8"));
		return Array.isArray(value) ? value.filter(isFeedback) : [];
	} catch { return []; }
}

export function readReviewAction(previewDir: string): "awaiting-review" | "request-changes" | "approved" {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(previewDir, REVIEW_FILE), "utf8"));
		if (value?.action === "request-changes" || value?.action === "approved") return value.action;
	} catch { /* default below */ }
	return "awaiting-review";
}

export function readApproval(previewDir: string): number | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(previewDir, APPROVAL_FILE), "utf8"));
		return value?.approved === true && typeof value.approvedAt === "number" ? value.approvedAt : undefined;
	} catch { return undefined; }
}

/** Start (or recover) a localhost-only preview server. */
export async function ensureDesignPreviewServer(previewDir: string): Promise<string> {
	initializeDesignReview(previewDir);
	const statePath = path.join(previewDir, SERVER_STATE_FILE);
	try {
		const old = JSON.parse(fs.readFileSync(statePath, "utf8"));
		if (typeof old?.port === "number" && processAlive(old.pid)) {
			// Always refresh the generated runtime when a workflow is upgraded
			// while its persistent preview server remains alive.
			fs.writeFileSync(path.join(previewDir, SERVER_FILE), serverSource());
			return `http://127.0.0.1:${old.port}`;
		}
	} catch { /* launch below */ }
	fs.writeFileSync(path.join(previewDir, SERVER_FILE), serverSource());
	const child = spawn(process.execPath, [SERVER_FILE], { cwd: previewDir, detached: true, stdio: "ignore" });
	child.unref();
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		try {
			const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
			if (typeof state?.port === "number") return `http://127.0.0.1:${state.port}`;
		} catch { /* server has not bound yet */ }
	}
	throw new Error("The isolated design preview server did not start.");
}

export function stopDesignPreviewServer(previewDir: string): void {
	try {
		const state = JSON.parse(fs.readFileSync(path.join(previewDir, SERVER_STATE_FILE), "utf8"));
		if (processAlive(state?.pid)) process.kill(state.pid, "SIGTERM");
	} catch { /* already gone */ }
}

function processAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid)) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function isFeedback(value: unknown): value is DesignFeedback {
	return Boolean(value && typeof value === "object" && typeof (value as DesignFeedback).id === "string" && typeof (value as DesignFeedback).comment === "string" && typeof (value as DesignFeedback).createdAt === "number");
}

/** Open the first mockup once using the operating system's default browser. */
export function openDesignPreview(url: string): boolean {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function installReviewRuntime(previewDir: string): void {
	fs.writeFileSync(path.join(previewDir, "dpbt-review.js"), reviewRuntime());
	fs.writeFileSync(path.join(previewDir, "dpbt-review.css"), reviewStyles());
}

function reviewRuntime(): string { return String.raw`(() => {
  const api = (url, body) => fetch(url, {method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body || {})}).then(r => r.json());
  const selected = new Set();
  const panel = document.createElement("aside"); panel.className = "dpbt-review";
  panel.innerHTML = '<div class="dpbt-eyebrow">Design review only</div><h2>Shape this screen</h2><p class="dpbt-intro">Select one or more highlighted areas, write feedback, then request a revision when you are ready.</p><div class="dpbt-selected">No elements selected</div><button class="dpbt-clear" type="button">Clear selected elements</button><label for="dpbt-comment">Your feedback</label><textarea id="dpbt-comment" placeholder="What should change, and why?"></textarea><button class="dpbt-send" type="button">Save feedback</button><div class="dpbt-comments" aria-live="polite"></div><div class="dpbt-actions"><button class="dpbt-request" type="button">Request changes</button><button class="dpbt-approve" type="button">Approve design</button></div><p class="dpbt-note">Approval sends this design and its decisions to implementation planning.</p>';
  document.body.append(panel);
  const selectedText = panel.querySelector(".dpbt-selected"), comment = panel.querySelector("textarea"), comments = panel.querySelector(".dpbt-comments");
  function escape(value) { const e=document.createElement("span"); e.textContent=value; return e.innerHTML; }
  function names(item) { return item.elements && item.elements.length ? item.elements.join(", ") : "General"; }
  function render(items) { comments.innerHTML = items.length ? '<h3>Feedback to send with your revision request</h3>' + items.map(x => '<p><strong>' + escape(names(x)) + '</strong><br>' + escape(x.comment) + '</p>').join("") : '<p class="dpbt-empty">No saved feedback yet. General comments work without selecting an element.</p>'; }
  function selectedNames() { return [...selected].map(element => element.dataset.dpbtAnnotate); }
  function renderSelected() { const names=selectedNames(); selectedText.textContent=names.length ? "Selected: " + names.join(", ") : "No elements selected"; }
  function clearSelected() { selected.clear(); document.querySelectorAll(".dpbt-picked").forEach(e=>e.classList.remove("dpbt-picked")); renderSelected(); }
  fetch("/api/state").then(r=>r.json()).then(s=>render(s.feedback || [])).catch(()=>{});
  document.addEventListener("click", event => { const target = event.target.closest("[data-dpbt-annotate]"); if (!target || panel.contains(target)) return; event.preventDefault(); if (selected.has(target)) { selected.delete(target); target.classList.remove("dpbt-picked"); } else { selected.add(target); target.classList.add("dpbt-picked"); } renderSelected(); }, true);
  panel.querySelector(".dpbt-clear").onclick = clearSelected;
  panel.querySelector(".dpbt-send").onclick = async () => { const text=comment.value.trim(); if (!text) { comment.focus(); return; } const state=await api("/api/feedback", {comment:text, elements:selectedNames(), page:location.pathname}); comment.value=""; clearSelected(); render(state.feedback || []); };
  panel.querySelector(".dpbt-request").onclick = async () => { const state=await api("/api/review", {action:"request-changes"}); panel.querySelector(".dpbt-note").textContent = state.message || "Revision requested. The design agent is updating the preview."; };
  panel.querySelector(".dpbt-approve").onclick = async () => { if (!confirm("Approve this final design and begin implementation planning?")) return; const state=await api("/api/approve"); panel.querySelector(".dpbt-note").textContent = state.message || "Approved. DPBT is handing it to the planner."; };
})();`; }

function reviewStyles(): string { return String.raw`.dpbt-review{position:fixed;z-index:2147483647;right:18px;bottom:18px;width:min(350px,calc(100vw - 36px));max-height:calc(100vh - 36px);overflow:auto;padding:20px;background:#f4efe5;color:#21251d;border:1px solid #807b6d;box-shadow:8px 8px 0 #c9bfa8;font:15px/1.4 Georgia,serif}.dpbt-review h2{margin:3px 0 8px;font-size:25px}.dpbt-eyebrow{text-transform:uppercase;letter-spacing:.12em;font:700 11px/1 sans-serif;color:#70674f}.dpbt-intro,.dpbt-note{margin:0 0 13px}.dpbt-selected{padding:8px 10px;background:#e4dccd;margin-bottom:7px;font-weight:bold}.dpbt-review label{display:block;font-weight:bold;margin:12px 0 4px}.dpbt-review textarea{box-sizing:border-box;width:100%;min-height:74px;padding:8px;border:1px solid #807b6d;background:#fffdf7;font:inherit}.dpbt-review button{cursor:pointer;padding:8px 10px;border:1px solid #30372a;background:#30372a;color:#fffdf7;font:700 13px/1 sans-serif}.dpbt-review .dpbt-clear{padding:4px 0;border:0;background:transparent;color:#30372a;text-decoration:underline}.dpbt-review .dpbt-send{margin-top:8px}.dpbt-actions{display:flex;gap:8px;margin-top:17px}.dpbt-actions .dpbt-request{background:#f4efe5;color:#30372a}.dpbt-actions .dpbt-approve{background:#54714d;border-color:#54714d}.dpbt-comments h3{margin:16px 0 5px;font-size:14px}.dpbt-comments p{margin:5px 0;padding:7px;border-left:3px solid #b88c46;background:#ebe4d6}.dpbt-empty{font-style:italic}.dpbt-picked{outline:3px solid #d87a28!important;outline-offset:3px}@media(max-width:600px){.dpbt-review{right:10px;bottom:10px;width:calc(100vw - 20px)}}`; }

function serverSource(): string { return String.raw`import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const root=process.cwd(), json=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(root,file),"utf8"))}catch{return fallback}}, write=(file,value)=>fs.writeFileSync(path.join(root,file),JSON.stringify(value,null,2));
const reply=(res,status,body)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(body));};
const server=http.createServer((req,res)=>{const url=new URL(req.url,"http://localhost"); if(url.pathname==="/api/state")return reply(res,200,{feedback:json("feedback.json",[]),review:json("review.json",{}),approval:json("approval.json",null)}); if(req.method==="POST"&&url.pathname.startsWith("/api/")){let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{let body={};try{body=JSON.parse(raw||"{}")}catch{return reply(res,400,{message:"Feedback could not be read."})}if(url.pathname==="/api/feedback"){const comment=typeof body.comment==="string"?body.comment.trim():"";if(!comment)return reply(res,400,{message:"Add feedback before saving."});const feedback=json("feedback.json",[]);const elements=Array.isArray(body.elements)?body.elements.filter(item=>typeof item==="string"&&item.trim()).map(item=>item.trim()):[];feedback.push({id:crypto.randomUUID(),comment,elements,page:typeof body.page==="string"?body.page:undefined,createdAt:Date.now()});write("feedback.json",feedback);return reply(res,200,{feedback,message:"Feedback saved. Add more notes or request changes."})}if(url.pathname==="/api/review"){write("review.json",{action:"request-changes",updatedAt:Date.now()});return reply(res,200,{message:"Revision requested. Keep this tab open; it will refresh when ready."})}if(url.pathname==="/api/approve"){const approvedAt=Date.now();write("approval.json",{approved:true,approvedAt});write("review.json",{action:"approved",updatedAt:approvedAt});return reply(res,200,{message:"Design approved. DPBT is handing it to the planner."})}return reply(res,404,{message:"Unknown review action."})});return;}let file=decodeURIComponent(url.pathname);if(file==="/")file="/index.html";const target=path.resolve(root,"."+file);if(!target.startsWith(root+path.sep))return reply(res,403,{message:"Forbidden"});fs.readFile(target,(error,data)=>{if(error){res.writeHead(404);return res.end("Preview file not found")}const type=target.endsWith(".html")?"text/html":target.endsWith(".js")?"text/javascript":target.endsWith(".css")?"text/css":"application/octet-stream";res.writeHead(200,{"content-type":type});res.end(data)})});server.listen(0,"127.0.0.1",()=>write("design-review-server.json",{pid:process.pid,port:server.address().port}));`; }
