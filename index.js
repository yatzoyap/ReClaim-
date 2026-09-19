// ReClaim — frontend logic (shared by every page)

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
// Official BOT Chain network details: https://dev-docs.botchain.ai/docs/Developers/quick-guide/
// Put the address you deployed ReClaim.sol to on each network. A contract only exists
// on the network you deployed it to, so leave "" for a network you haven't deployed on.
const NETWORKS = {
    968: {
        label: "BOT Testnet",
        contract: "0xf29614100602bEbc020B752285725Eb5bF4decb7",
        params: {
            chainId: "0x3c8",
            chainName: "BOT Chain Testnet",
            rpcUrls: ["https://rpc.bohr.life"],
            nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
            blockExplorerUrls: ["https://scan.bohr.life"]
        }
    },
    677: {
        label: "BOT Mainnet",
        contract: "0xf29614100602bEbc020B752285725Eb5bF4decb7",
        params: {
            chainId: "0x2a5",
            chainName: "BOT Chain",
            rpcUrls: ["https://rpc.botchain.ai"],
            nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
            blockExplorerUrls: ["https://scan.botchain.ai"]
        }
    }
};
const FAUCET_URL = "https://faucet.botchain.ai/basic";

// Which network the site talks to (remembered between pages).
let targetChainId = 968;
try {
    const saved = Number(localStorage.getItem("reclaim_chain"));
    if (NETWORKS[saved]) targetChainId = saved;
} catch (e) {}

const CONTRACT_ABI = [
    "function registerItem(string publicCode, string name, bytes32 secretHash) external",
    "function reportFound(string publicCode, string locationName, uint32 lat, uint32 lng, string contact) external",
    "function claimItemAndReset(string publicCode, string secretCode) external",
    "function dismissReport(string publicCode) external",
    "function getItem(string publicCode) external view returns (tuple(bytes32 secretHash, address owner, address finder, uint8 status, uint32 lat, uint32 lng, uint64 registeredAt, uint64 foundAt, string publicCode, string name, string foundLocationName, string finderContact))",
    "function getOwnerCodes(address owner) external view returns (string[] memory)",
    "error UnknownCode()",
    "error CodeLengthInvalid()",
    "error NameLengthInvalid()",
    "error MissingSecretHash()",
    "error CodeAlreadyUsed()",
    "error ItemNotOpen()",
    "error NotOriginalFinder()",
    "error LocationInvalid()",
    "error Unauthorized()",
    "error WrongSecretCode()",
    "error InvalidStatus()"
];

const ERROR_MESSAGES = {
    UnknownCode: "That public code isn't registered.",
    CodeLengthInvalid: "The public code must be 6 to 32 characters.",
    NameLengthInvalid: "The item name must be 1 to 60 characters.",
    MissingSecretHash: "A secret code is required.",
    CodeAlreadyUsed: "This code is already registered. Generate a new one.",
    ItemNotOpen: "This item can't be reported right now.",
    NotOriginalFinder: "Someone else has already reported this item.",
    LocationInvalid: "Location name (max 100 characters) or contact (max 80) is invalid.",
    Unauthorized: "Only the wallet that registered this item can do that.",
    WrongSecretCode: "Wrong secret code.",
    InvalidStatus: "This item hasn't been reported found yet."
};

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
let provider, signer, contract, account;

const $ = (id) => document.getElementById(id);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message, type = "info", ms = 5000) {
    let box = $("toasts");
    if (!box) {
        box = document.createElement("div");
        box.id = "toasts";
        document.body.appendChild(box);
    }
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
}

function friendlyError(err) {
    if (err && (err.code === "ACTION_REJECTED" || err.code === 4001)) return "You cancelled the request in your wallet.";
    if (err && err.code === -32002) return "A MetaMask request is already open. Open the MetaMask window and approve it.";
    if (err && err.code === "INSUFFICIENT_FUNDS") return "Not enough BOT to pay for gas. On the testnet you can get free tokens from " + FAUCET_URL;
    const name = err && err.revert && err.revert.name;
    if (name && ERROR_MESSAGES[name]) return ERROR_MESSAGES[name];
    return (err && (err.shortMessage || err.reason || err.message)) || "Something went wrong.";
}

async function withBusy(buttonId, busyLabel, task) {
    const btn = $(buttonId);
    const original = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
    try {
        await task();
    } catch (err) {
        console.error(err);
        toast(friendlyError(err), "error", 7000);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}

// ---------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------
function updateWalletUI() {
    document.querySelectorAll(".js-connect").forEach((el) => {
        if (account) {
            el.textContent = short(account);
            el.title = account;
            el.classList.add("on");
        } else {
            el.textContent = "Connect wallet";
            el.title = "";
            el.classList.remove("on");
        }
    });
    const line = $("walletAddress");
    if (line) line.textContent = account ? "Connected: " + account + " on " + NETWORKS[targetChainId].label : "";
    const sel = $("networkSelect");
    if (sel) sel.value = String(targetChainId);
}

function setTarget(chainId) {
    targetChainId = chainId;
    try { localStorage.setItem("reclaim_chain", String(chainId)); } catch (e) {}
    updateWalletUI();
}

// Called by the network dropdown in the nav.
function changeNetwork(value) {
    setTarget(Number(value));
    contract = null;
    if (account) setupWallet(true);
}

// Switch MetaMask to the selected network, adding it first if MetaMask doesn't know it yet.
async function ensureNetwork() {
    const net = NETWORKS[targetChainId];
    const current = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    if (current === targetChainId) return;
    try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: net.params.chainId }] });
    } catch (err) {
        const code = err.code || (err.data && err.data.originalError && err.data.originalError.code);
        if (code === 4902 || code === -32603) {
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [net.params] });
        } else {
            throw err;
        }
    }
}

// requestAccess=true opens MetaMask popups (connect + network switch); false only reconnects silently.
async function setupWallet(requestAccess) {
    if (!window.ethereum) {
        const onFile = location.protocol === "file:";
        toast(
            onFile
                ? "No wallet detected. If you opened this as a file, run it from a local server (e.g. VS Code Live Server) or enable file access for MetaMask."
                : "No wallet detected. Install MetaMask and reload the page.",
            "error", 8000
        );
        return false;
    }

    try {
        if (requestAccess) {
            await window.ethereum.request({ method: "eth_requestAccounts" });
            await ensureNetwork();
        } else {
            const accounts = await window.ethereum.request({ method: "eth_accounts" });
            if (!accounts.length) return false;
        }

        // A fresh provider after any network switch (ethers caches the network).
        provider = new ethers.BrowserProvider(window.ethereum);
        const chainId = Number((await provider.getNetwork()).chainId);

        if (!NETWORKS[chainId]) {
            contract = signer = account = null;
            updateWalletUI();
            renderItems(null);
            toast("Your wallet is on chain " + chainId + ", which isn't a BOT Chain network. Click Connect wallet to switch to " + NETWORKS[targetChainId].label + ".", "error", 9000);
            return false;
        }
        if (chainId !== targetChainId) setTarget(chainId); // follow the wallet

        signer = await provider.getSigner();
        account = await signer.getAddress();

        const net = NETWORKS[chainId];
        const code = net.contract ? await provider.getCode(net.contract) : "0x";
        if (code === "0x") {
            contract = null;
            updateWalletUI();
            renderItems(null);
            const other = chainId === 968 ? NETWORKS[677].label : NETWORKS[968].label;
            toast("Connected to " + net.label + ", but no ReClaim contract is deployed there" + (net.contract ? " at " + net.contract : "") + ". If you deployed on " + other + ", pick it in the network menu.", "error", 10000);
            return false;
        }

        contract = new ethers.Contract(net.contract, CONTRACT_ABI, signer);
        updateWalletUI();
        if (requestAccess) toast("Connected to " + net.label + ".", "success", 2500);
        await loadItems();
        return true;
    } catch (err) {
        console.error(err);
        toast(friendlyError(err), "error", 7000);
        return false;
    }
}

function connectWallet() { return setupWallet(true); }

async function requireWallet() {
    if (contract) return true;
    return setupWallet(true);
}

// Reconnect silently on every page, and follow wallet changes.
window.addEventListener("DOMContentLoaded", () => {
    updateWalletUI();
    renderItems(null);
    if (window.matchMedia("(max-width: 760px)").matches) {
        const p = $("panel");
        if (p) p.classList.add("collapsed");
    }
    if (window.ethereum) {
        setupWallet(false);
        window.ethereum.on("accountsChanged", (accs) => {
            if (!accs.length) { contract = signer = account = null; updateWalletUI(); renderItems(null); }
            else setupWallet(false);
        });
        window.ethereum.on("chainChanged", () => setupWallet(false));
    }
});

// ---------------------------------------------------------------
// Items panel (read from the chain, so it's always accurate)
// ---------------------------------------------------------------
function togglePanel() {
    const p = $("panel");
    if (p) p.classList.toggle("collapsed");
}

async function loadItems() {
    if (!contract || !account) return renderItems(null);
    try {
        const codes = await contract.getOwnerCodes(account);
        const items = await Promise.all(codes.map((c) => contract.getItem(c)));
        renderItems(items.map((i) => {
            const found = Number(i.status) === 1;
            return {
                name: i.name,
                code: i.publicCode,
                found,
                place: found ? i.foundLocationName : "",
                // lat/lng are stored as 32-bit two's complement; "| 0" restores the sign.
                lat: found ? (Number(i.lat) | 0) / 1e6 : null,
                lng: found ? (Number(i.lng) | 0) / 1e6 : null,
                contact: found ? i.finderContact : ""
            };
        }));
    } catch (err) {
        console.error(err);
    }
}

function renderItems(items) {
    const list = $("items-list");
    if (!list) return;
    const count = $("itemCount");
    if (count) count.textContent = items ? items.length : "";

    if (items === null) {
        list.innerHTML = '<p class="panel-empty">Connect your wallet to see your items.</p>';
        return;
    }
    if (!items.length) {
        list.innerHTML = '<p class="panel-empty">No items registered yet.</p>';
        return;
    }
    list.innerHTML = items.map((i) => `
        <div class="registered-item">
            <div style="min-width:0">
                <span class="nm">${esc(i.name)}</span>
                <span class="cd">${esc(i.code)}</span>
                ${i.found ? `<a class="loc" href="https://www.openstreetmap.org/?mlat=${i.lat}&mlon=${i.lng}#map=16/${i.lat}/${i.lng}" target="_blank" rel="noopener">${esc(i.place)} (${i.lat}, ${i.lng})</a>` : ""}
                ${i.found && i.contact ? `<span class="cd">Contact: ${esc(i.contact)}</span>` : ""}
            </div>
            <span class="status-badge ${i.found ? "found" : ""}">${i.found ? "Found" : "Safe"}</span>
        </div>`).join("");
}

// ---------------------------------------------------------------
// Register
// ---------------------------------------------------------------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomString(length) {
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function generatePublicCode() {
    const input = $("regPublicCode");
    if (input) input.value = "TAG-" + randomString(8);
}
window.addEventListener("DOMContentLoaded", generatePublicCode);

async function handleRegistration() {
    if (!(await requireWallet())) return;

    const publicCode = $("regPublicCode").value.trim();
    const name = $("regName").value.trim();
    if (!publicCode || !name) {
        toast("Enter an item name.", "error");
        return;
    }

    // The secret code is generated for the owner and shown once after registering.
    const secretCode = "sec_" + randomString(12);

    await withBusy("registerBtn", "Confirm in wallet…", async () => {
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "address"],
            [publicCode, secretCode, account]
        );
        const secretHash = ethers.keccak256(encoded);

        const tx = await contract.registerItem(publicCode, name, secretHash);
        $("registerBtn").textContent = "Registering…";
        await tx.wait();

        await loadItems();
        showReceipt({ name, publicCode, secretCode, txHash: tx.hash });
        toast("Item registered.", "success", 3000);
        $("regName").value = "";
        generatePublicCode();
    });
}

// Shown once, right after registering. The secret is never stored by the site,
// and it can't be recovered from the chain, so this is the owner's only copy.
function showReceipt(r) {
    const box = $("receipt");
    if (!box) return;
    const explorer = NETWORKS[targetChainId].params.blockExplorerUrls[0];
    box.dataset.name = r.name;
    box.dataset.code = r.publicCode;
    box.dataset.secret = r.secretCode;
    box.dataset.tx = r.txHash;
    box.innerHTML = `
        <h2>Item registered. Save your secret code now.</h2>
        <div class="receipt-row"><span>Item</span><strong>${esc(r.name)}</strong></div>
        <div class="receipt-row"><span>Public code</span>
            <code>${esc(r.publicCode)}</code>
            <button class="copy-btn" type="button" data-value="${esc(r.publicCode)}" onclick="copyText(this.dataset.value)">Copy</button></div>
        <div class="receipt-row"><span>Secret code</span>
            <code class="secret">${esc(r.secretCode)}</code>
            <button class="copy-btn" type="button" data-value="${esc(r.secretCode)}" onclick="copyText(this.dataset.value)">Copy</button></div>
        <p class="hint">This is the only time it is shown. It is stored on-chain only as a hash and cannot be recovered. You need it to claim this item.</p>
        <div class="receipt-actions">
            <button class="btn btn-secondary btn-auto" type="button" onclick="downloadReceipt()">Download as text file</button>
            <a class="btn btn-secondary btn-auto" href="${esc(explorer)}/tx/${esc(r.txHash)}" target="_blank" rel="noopener">View transaction</a>
            <button class="btn btn-secondary btn-auto" type="button" onclick="hideReceipt()">I've saved it</button>
        </div>`;
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideReceipt() {
    const box = $("receipt");
    if (!box) return;
    box.hidden = true;
    box.innerHTML = "";
    box.dataset.secret = "";
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }
    toast("Copied.", "success", 1500);
}

function downloadReceipt() {
    const box = $("receipt");
    if (!box) return;
    const text = [
        "ReClaim item",
        "Item name:   " + box.dataset.name,
        "Public code: " + box.dataset.code,
        "Secret code: " + box.dataset.secret,
        "Network:     " + NETWORKS[targetChainId].label,
        "Transaction: " + box.dataset.tx,
        "",
        "Keep this file private. The secret code cannot be recovered."
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "reclaim-" + box.dataset.code + ".txt";
    a.click();
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------
// Report found
// ---------------------------------------------------------------
// The contract stores lat/lng as uint32. Negative coordinates are stored as
// their 32-bit two's-complement value (>>> 0); decode with `| 0` to read them back.
const toU32 = (deg) => Math.round(deg * 1e6) >>> 0;

async function reportFound() {
    if (!(await requireWallet())) return;

    const publicCode = $("foundPublicCode").value.trim();
    const locationName = $("foundLocation").value.trim();
    const lat = parseFloat($("foundLat").value);
    const lng = parseFloat($("foundLng").value);
    const contact = $("foundContact").value.trim();

    if (!publicCode || !locationName || isNaN(lat) || isNaN(lng)) {
        toast("Enter the public code, a location name and coordinates.", "error");
        return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        toast("Coordinates are out of range.", "error");
        return;
    }

    await withBusy("reportBtn", "Confirm in wallet…", async () => {
        const tx = await contract.reportFound(publicCode, locationName, toU32(lat), toU32(lng), contact);
        $("reportBtn").textContent = "Reporting…";
        await tx.wait();
        await loadItems();
        toast("Reported. The owner can now see where you found it.", "success");
    });
}

// ---------------------------------------------------------------
// Claim
// ---------------------------------------------------------------
async function handleClaim() {
    if (!(await requireWallet())) return;

    const publicCode = $("claimPublicCode").value.trim();
    const secretCode = $("claimSecretCode").value;

    if (!publicCode || !secretCode) {
        toast("Enter both the public code and your secret code.", "error");
        return;
    }

    await withBusy("claimBtn", "Confirm in wallet…", async () => {
        const tx = await contract.claimItemAndReset(publicCode, secretCode);
        $("claimBtn").textContent = "Claiming…";
        await tx.wait();
        await loadItems();
        toast("Claimed. The tag is reset and ready to use again.", "success");
        $("claimSecretCode").value = "";
    });
}
