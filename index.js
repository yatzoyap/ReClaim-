// index.js
// Front end for ReClaim.sol. Uses ethers v6 to talk to the contract.

// ---------------------------------------------------------------
// 0. Settings
// ---------------------------------------------------------------

// Address of ReClaim.sol after deploying it in Remix.
const contractAddress = "0xf29614100602bEbc020B752285725Eb5bF4decb7";

// The QR code on a tag links to this page. Leave it empty to use whatever
// address the page is opened from right now. Before you print real tags,
// put your live site here, e.g. "https://yourname.github.io/reclaim/"
const APP_URL = "";

const contractABI = [
    "function registerItem(string publicCode, string name, bytes32 secretHash)",
    "function reportFound(string publicCode, string locationName, uint32 lat, uint32 lng, string contact)",
    "function claimItemAndReset(string publicCode, string secretCode)",
    "function dismissReport(string publicCode)",
    "function getItem(string publicCode) view returns (tuple(bytes32 secretHash, address owner, address finder, uint8 status, uint32 lat, uint32 lng, uint64 registeredAt, uint64 foundAt, string publicCode, string name, string foundLocationName, string finderContact))",
    "function getOwnerCodes(address owner) view returns (string[])",

    // Custom errors, so ethers can tell us which one the contract threw
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

// What the user sees when the contract rejects something
const contractErrors = {
    UnknownCode: "That public code isn't registered. Check the code on the tag.",
    CodeLengthInvalid: "The public code must be 6 to 32 characters.",
    NameLengthInvalid: "The item name must be 1 to 60 characters.",
    MissingSecretHash: "The secret code is missing.",
    CodeAlreadyUsed: "That public code is already taken. Get new codes and try again.",
    ItemNotOpen: "This item can't be reported right now.",
    NotOriginalFinder: "Someone else already reported this item. Only they can update the report.",
    LocationInvalid: "The location name must be 1 to 100 characters and the contact 80 or fewer.",
    Unauthorized: "Only the owner of this item can do that. Switch to the wallet that registered it.",
    WrongSecretCode: "That secret code doesn't match this item.",
    InvalidStatus: "This item hasn't been reported as found."
};


// ---------------------------------------------------------------
// 1. Small helpers
// ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// Item names and locations come from the blockchain, so anyone could have typed
// anything. Escape them before putting them into HTML.
function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function shortAddr(address) {
    return address.slice(0, 6) + "…" + address.slice(-4);
}

function formatDate(seconds, withTime = false) {
    const options = withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" };
    return new Date(seconds * 1000).toLocaleString(undefined, options);
}

let toastTimer;
function showToast(message, type = "info") {
    const toast = $("toast");
    toast.textContent = message;
    toast.className = "toast " + type;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, type === "error" ? 8000 : 4500);
}

// Different wallets and nodes hide the contract's error data in different places,
// so search through the error object until we find something we can decode.
function findContractError(value, depth = 0) {
    if (value == null || depth > 5 || !readContract) return null;

    if (typeof value === "string") {
        if (!/^0x[0-9a-fA-F]{8,}$/.test(value)) return null;
        try {
            const parsed = readContract.interface.parseError(value);
            return parsed ? parsed.name : null;
        } catch (e) {
            return null;
        }
    }
    if (typeof value === "object") {
        for (const key of Object.keys(value)) {
            const found = findContractError(value[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

// Turns whatever went wrong into a sentence a person can act on
function friendlyError(err) {
    if (err.code === "ACTION_REJECTED") return "You cancelled the request in your wallet.";

    // Which custom error did the contract throw?
    const name = (err.revert && err.revert.name)
        || findContractError(err.data)
        || findContractError(err.info && err.info.error);
    if (name && contractErrors[name]) return contractErrors[name];

    // Reading from an address with no contract on it
    if (err.code === "BAD_DATA") {
        return "Couldn't read the contract. Make sure your wallet is on the network where ReClaim is deployed.";
    }
    return err.shortMessage || err.reason || err.message || "Something went wrong.";
}

// People may paste the whole tag link instead of just the code
function cleanCode(text) {
    text = text.trim();
    try {
        const fromLink = new URL(text).searchParams.get("code");
        if (fromLink) return fromLink.trim();
    } catch (e) { /* not a link, that's fine */ }
    return text;
}

async function copyText(text, message) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(message, "success");
    } catch (e) {
        showToast("Couldn't copy automatically. Select the text and copy it yourself.", "error");
    }
}


// ---------------------------------------------------------------
// 2. Page navigation
// ---------------------------------------------------------------

function showPage(pageId) {
    document.querySelectorAll(".page-section").forEach((s) => s.classList.remove("active"));
    $(pageId).classList.add("active");

    document.querySelectorAll(".nav-links button").forEach((b) => {
        b.classList.remove("active");
        b.removeAttribute("aria-current");
    });
    $("nav-" + pageId).classList.add("active");
    $("nav-" + pageId).setAttribute("aria-current", "page");

    window.scrollTo(0, 0);

    // Leaflet can't measure a hidden map, so fix the size now that it's visible
    if (pageId === "found") {
        initPickMap();
        if (pickMap) pickMap.invalidateSize();
    }
    if (pageId === "items") itemMaps.forEach((m) => m.invalidateSize());
}


// ---------------------------------------------------------------
// 3. Coordinates
//
// The contract stores lat/lng as uint32, which can't hold negative numbers
// (Jakarta is at latitude -6.2, for example). So we shift them before saving:
//   latitude  -90..90   becomes 0..180 million
//   longitude -180..180 becomes 0..360 million
// and shift them back when reading.
// ---------------------------------------------------------------

const COORD_SCALE = 1000000;

const encodeLat = (lat) => Math.round((lat + 90) * COORD_SCALE);
const encodeLng = (lng) => Math.round((lng + 180) * COORD_SCALE);
const decodeLat = (raw) => Number(raw) / COORD_SCALE - 90;
const decodeLng = (raw) => Number(raw) / COORD_SCALE - 180;


// ---------------------------------------------------------------
// 4. Wallet
// ---------------------------------------------------------------

let provider, signer, account;
let contract;      // can send transactions (needs a connected wallet)
let readContract;  // can only read (works before connecting)
let localItems = [];

function setupProvider() {
    if (!window.ethereum) return;
    provider = new ethers.BrowserProvider(window.ethereum);
    readContract = new ethers.Contract(contractAddress, contractABI, provider);

    window.ethereum.on("accountsChanged", (accounts) => {
        if (accounts.length > 0) setupSigner(); else clearWallet();
    });
    window.ethereum.on("chainChanged", () => window.location.reload());
}

async function connectWallet() {
    if (!window.ethereum) {
        showToast("No wallet found. Install MetaMask or another Web3 wallet to continue.", "error");
        return;
    }
    try {
        await provider.send("eth_requestAccounts", []);
        await setupSigner();
    } catch (err) {
        showToast(friendlyError(err), "error");
    }
}

async function setupSigner() {
    signer = await provider.getSigner();
    account = await signer.getAddress();
    contract = new ethers.Contract(contractAddress, contractABI, signer);
    updateWalletUI();
    await loadMyItems();
}

function clearWallet() {
    signer = account = contract = undefined;
    localItems = [];
    updateWalletUI();
}

function updateWalletUI() {
    const button = $("connectBtn");
    if (account) {
        button.textContent = shortAddr(account);
        button.title = account;
        button.disabled = true;
        button.classList.add("connected");
        $("walletLine").textContent = "Connected as " + account;
    } else {
        button.textContent = "Connect wallet";
        button.title = "";
        button.disabled = false;
        button.classList.remove("connected");
    }
    $("intro").hidden = Boolean(account);
    $("dashboard").hidden = !account;
}

function requireWallet() {
    if (!contract) {
        showToast("Connect your wallet first.", "error");
        return false;
    }
    return true;
}

// Sends a transaction and keeps the button updated while we wait.
// Returns true if it went through.
async function sendTx(button, makeTx) {
    const originalLabel = button.textContent;
    button.disabled = true;
    try {
        button.textContent = "Confirm in your wallet…";
        const tx = await makeTx();
        button.textContent = "Waiting for the network…";
        await tx.wait();
        return true;
    } catch (err) {
        console.error(err);
        showToast(friendlyError(err), "error");
        return false;
    } finally {
        button.disabled = false;
        button.textContent = originalLabel;
    }
}


// ---------------------------------------------------------------
// 5. Reading items from the contract
// ---------------------------------------------------------------

// Turns the raw contract struct into a plain object
function parseItem(raw) {
    return {
        code: raw.publicCode,
        name: raw.name,
        owner: raw.owner === ethers.ZeroAddress ? null : raw.owner,
        finder: raw.finder,
        isFound: Number(raw.status) === 1,
        lat: decodeLat(raw.lat),
        lng: decodeLng(raw.lng),
        locationName: raw.foundLocationName,
        contact: raw.finderContact,
        registeredAt: Number(raw.registeredAt),
        foundAt: Number(raw.foundAt)
    };
}

async function loadMyItems() {
    if (!account) return;
    $("items-list").innerHTML = '<p class="hint">Loading your items…</p>';
    try {
        const codes = [...(await readContract.getOwnerCodes(account))];
        const rawItems = await Promise.all(codes.map((code) => readContract.getItem(code)));
        localItems = rawItems.map(parseItem).reverse();   // newest first
        renderItems();
    } catch (err) {
        console.error(err);
        $("items-list").innerHTML = "";
        showToast(friendlyError(err), "error");
    }
}


// ---------------------------------------------------------------
// 6. The item list
// ---------------------------------------------------------------

let itemMaps = [];   // small maps shown on "Found" items

function renderItems() {
    itemMaps.forEach((m) => m.remove());
    itemMaps = [];

    const list = $("items-list");
    if (localItems.length === 0) {
        list.innerHTML = `
            <div class="empty">
                <p>You haven't registered anything yet.</p>
                <button class="btn primary" onclick="showPage('register')">Register your first item</button>
            </div>`;
        return;
    }

    list.innerHTML = localItems.map(itemHtml).join("");

    localItems.forEach((item, i) => {
        if (item.isFound) drawItemMap("map-" + i, item.lat, item.lng);
    });
}

function itemHtml(item, index) {
    const status = item.isFound ? "found" : "registered";
    const statusLabel = item.isFound ? "Found" : "Registered";

    const details = item.isFound
        ? foundDetailsHtml(item, index)
        : `<p class="item-note">Registered on ${formatDate(item.registeredAt)}. Nobody has reported it found.</p>`;

    return `
        <article class="item ${status}">
            <div class="item-head">
                <div>
                    <h3>${esc(item.name)} <span class="badge ${status}">${statusLabel}</span></h3>
                    <p class="item-code">${esc(item.code)}</p>
                </div>
                <button class="btn small" data-action="tag" data-code="${esc(item.code)}">View tag</button>
            </div>
            ${details}
        </article>`;
}

function foundDetailsHtml(item, index) {
    const osmLink = `https://www.openstreetmap.org/?mlat=${item.lat}&mlon=${item.lng}#map=17/${item.lat}/${item.lng}`;
    return `
        <div class="item-found">
            <div>
                <dl>
                    <dt>Found at</dt><dd>${esc(item.locationName)}</dd>
                    <dt>Reported</dt><dd>${formatDate(item.foundAt, true)}</dd>
                    <dt>Contact</dt><dd>${item.contact ? esc(item.contact) : "None given"}</dd>
                    <dt>Finder's wallet</dt><dd>${shortAddr(item.finder)}</dd>
                </dl>
                <div class="item-actions">
                    <button class="btn primary" data-action="claim" data-code="${esc(item.code)}">Claim item</button>
                    <button class="btn" data-action="dismiss" data-code="${esc(item.code)}">Dismiss report</button>
                </div>
                <a href="${osmLink}" target="_blank" rel="noopener">Open in OpenStreetMap</a>
            </div>
            <div class="map" id="map-${index}"></div>
        </div>`;
}

// One listener for every button inside the list
$("items-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const code = button.dataset.code;
    if (button.dataset.action === "claim") startClaim(code);
    if (button.dataset.action === "dismiss") dismissReport(code, button);
    if (button.dataset.action === "tag") viewTag(code);
});

async function dismissReport(code, button) {
    if (!requireWallet()) return;
    const ok = confirm("Dismiss this report? The item goes back to Registered and the finder's details are cleared.");
    if (!ok) return;

    if (await sendTx(button, () => contract.dismissReport(code))) {
        showToast("Report dismissed.", "success");
        loadMyItems();
    }
}

function startClaim(code) {
    $("claimPublicCode").value = code;
    $("claimSecretCode").value = "";
    showPage("claim");
    $("claimSecretCode").focus();
}


// ---------------------------------------------------------------
// 7. Maps (Leaflet + OpenStreetMap)
// ---------------------------------------------------------------

function addTiles(map) {
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
}

function pinIcon() {
    return L.divIcon({ className: "map-pin", iconSize: [22, 22], iconAnchor: [11, 11] });
}

// Small read-only map on a found item
function drawItemMap(elementId, lat, lng) {
    if (typeof L === "undefined") return;
    const map = L.map(elementId, { scrollWheelZoom: false }).setView([lat, lng], 16);
    addTiles(map);
    L.marker([lat, lng], { icon: pinIcon() }).addTo(map);
    itemMaps.push(map);
}

// The map the finder uses to drop a pin
let pickMap, pickMarker;
let pickedPoint = null;

function initPickMap() {
    if (pickMap) return;
    if (typeof L === "undefined") {
        $("foundMap").textContent = "The map couldn't load. Check your internet connection and reload.";
        return;
    }
    pickMap = L.map("foundMap").setView([20, 0], 2);
    addTiles(pickMap);
    pickMap.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng));
}

function setPin(lat, lng, zoom) {
    const point = L.latLng(Math.max(-90, Math.min(90, lat)), lng).wrap();
    pickedPoint = { lat: point.lat, lng: point.lng };

    if (pickMarker) {
        pickMarker.setLatLng(point);
    } else {
        pickMarker = L.marker(point, { icon: pinIcon(), draggable: true }).addTo(pickMap);
        pickMarker.on("dragend", () => {
            const p = pickMarker.getLatLng();
            setPin(p.lat, p.lng);
        });
    }
    if (zoom) pickMap.setView(point, zoom);

    $("foundCoords").textContent = `Pin at ${pickedPoint.lat.toFixed(5)}, ${pickedPoint.lng.toFixed(5)}`;
}

function useMyLocation() {
    if (!navigator.geolocation) {
        showToast("Your browser can't share your location. Drop a pin on the map instead.", "error");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (pos) => setPin(pos.coords.latitude, pos.coords.longitude, 17),
        () => showToast("Couldn't get your location. Drop a pin on the map instead.", "error")
    );
}

// Looks up the place name in OpenStreetMap's free search and moves the pin there
async function findOnMap() {
    const query = $("foundLocation").value.trim();
    if (!query) {
        showToast("Type a place name first.", "error");
        return;
    }
    try {
        const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query);
        const results = await (await fetch(url)).json();
        if (results.length === 0) {
            showToast("Couldn't find that place. Click the map to drop a pin instead.", "error");
            return;
        }
        setPin(parseFloat(results[0].lat), parseFloat(results[0].lon), 17);
    } catch (err) {
        showToast("Place search isn't available right now. Click the map to drop a pin instead.", "error");
    }
}


// ---------------------------------------------------------------
// 8. Tags: codes, QR and printing
// ---------------------------------------------------------------

// No 0/O or 1/I so codes are easy to read out and type.
// Exactly 32 characters, so picking one at random has no bias.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomString(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

// The link stored in the QR code, e.g. https://site/index.html?code=TAG-K7QM2XWN
function tagLink(code) {
    const url = new URL(APP_URL || window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("code", code);
    return url.toString();
}

function qrSvg(text) {
    if (typeof qrcode === "undefined") return "";
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();

    const size = qr.getModuleCount();
    let squares = "";
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (qr.isDark(row, col)) squares += `M${col} ${row}h1v1h-1z`;
        }
    }
    // The -2 / +4 leaves the blank border a scanner needs
    return `<svg viewBox="-2 -2 ${size + 4} ${size + 4}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${esc(text)}">
                <path d="${squares}" fill="currentColor"/>
            </svg>`;
}

function tagHtml(name, code) {
    const qr = code
        ? `<div class="tag-qr">${qrSvg(tagLink(code))}</div>`
        : `<div class="tag-qr empty">QR code appears after you register</div>`;
    return `
        <div class="tag">
            <p class="tag-lead">Found this? Scan to tell the owner.</p>
            ${qr}
            <p class="tag-name">${esc(name)}</p>
            <p class="tag-code">${code ? esc(code) : "Code is generated after registration"}</p>
        </div>`;
}

function printTag(name, code) {
    $("printArea").innerHTML = tagHtml(name, code);
    window.print();
}

// "View tag" pop-up in the item list
let dialogItem = null;

function viewTag(code) {
    const item = localItems.find((i) => i.code === code);
    if (!item) return;
    dialogItem = item;
    $("tagDialogBody").innerHTML = tagHtml(item.name, item.code);
    $("tagDialog").showModal();
}

const printDialogTag = () => printTag(dialogItem.name, dialogItem.code);
const copyDialogLink = () => copyText(tagLink(dialogItem.code), "Tag link copied.");


// ---------------------------------------------------------------
// 9. Register
// ---------------------------------------------------------------

let justRegistered = null;   // {name, code, secret} after a successful registration

// Made fresh each time someone presses Register. They only become visible
// once the transaction has gone through.
function makeCodes() {
    return {
        publicCode: "TAG-" + randomString(8),
        // 16 random characters in groups of four: K7QM-42HD-XWNP-R9TB
        secretCode: randomString(16).match(/.{4}/g).join("-")
    };
}

// Before registering there is no code yet, so the tag shows a placeholder instead of a QR
function updateRegisterPreview() {
    const name = $("regName").value.trim() || "Your item";
    $("regTagPreview").innerHTML = tagHtml(name, null);
}

// The hash the contract expects: keccak256(abi.encode(publicCode, secretCode, owner))
function makeSecretHash(publicCode, secretCode, owner) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "address"],
        [publicCode, secretCode, owner]
    );
    return ethers.keccak256(encoded);
}

async function handleRegistration() {
    if (!requireWallet()) return;

    const name = $("regName").value.trim();
    if (!name) {
        showToast("Give your item a name first.", "error");
        $("regName").focus();
        return;
    }

    const { publicCode, secretCode } = makeCodes();
    const secretHash = makeSecretHash(publicCode, secretCode, account);

    const ok = await sendTx($("regBtn"), () => contract.registerItem(publicCode, name, secretHash));
    if (!ok) return;   // nothing was registered, so the codes are simply thrown away

    justRegistered = { name, code: publicCode, secret: secretCode };
    $("regDonePublic").textContent = publicCode;
    $("regDoneSecret").textContent = secretCode;
    $("regForm").hidden = true;
    $("regDone").hidden = false;
    $("regTagPreview").innerHTML = tagHtml(name, publicCode);
    loadMyItems();
}

function registerAnother() {
    justRegistered = null;
    $("regName").value = "";
    $("regDone").hidden = true;
    $("regForm").hidden = false;
    updateRegisterPreview();
    $("regName").focus();
}

const printCurrentTag = () => printTag(justRegistered.name, justRegistered.code);
const copyCurrentLink = () => copyText(tagLink(justRegistered.code), "Tag link copied.");


// ---------------------------------------------------------------
// 10. Finder: report an item as found
// ---------------------------------------------------------------

// Shows the item's name under the code field, so the finder knows they typed it right
async function lookUpFoundItem() {
    const box = $("foundLookup");
    const code = cleanCode($("foundPublicCode").value);
    $("foundPublicCode").value = code;

    if (!code) {
        box.hidden = true;
        return;
    }
    if (!readContract) {
        showToast("No wallet found. Install MetaMask or another Web3 wallet to continue.", "error");
        return;
    }

    try {
        const item = parseItem(await readContract.getItem(code));
        box.hidden = false;

        if (!item.owner) {
            box.className = "lookup bad";
            box.textContent = "No item has this code. Check the code on the tag.";
        } else if (item.isFound) {
            box.className = "lookup warn";
            const mine = account && item.finder.toLowerCase() === account.toLowerCase();
            box.innerHTML = mine
                ? `<strong>${esc(item.name)}</strong> is already reported by you. Sending again updates your report.`
                : `<strong>${esc(item.name)}</strong> was already reported found. Only the person who reported it can update it.`;
        } else {
            box.className = "lookup";
            box.innerHTML = `This tag belongs to <strong>${esc(item.name)}</strong>. Thank you for helping.`;
        }
    } catch (err) {
        box.hidden = false;
        box.className = "lookup bad";
        box.textContent = friendlyError(err);
    }
}

async function handleReportFound() {
    if (!requireWallet()) return;

    const publicCode = cleanCode($("foundPublicCode").value);
    const locationName = $("foundLocation").value.trim();
    const contact = $("foundContact").value.trim();

    if (!publicCode) {
        showToast("Enter the public code from the tag.", "error");
        return;
    }
    if (!locationName) {
        showToast("Tell us where the item is, for example the name of the place.", "error");
        return;
    }
    if (!pickedPoint) {
        showToast("Click the map to drop a pin where the item is.", "error");
        return;
    }

    const lat = encodeLat(pickedPoint.lat);
    const lng = encodeLng(pickedPoint.lng);

    const ok = await sendTx($("foundBtn"), () => contract.reportFound(publicCode, locationName, lat, lng, contact));
    if (!ok) return;

    showToast("Reported. The owner will see it in their list.", "success");
    $("foundPublicCode").value = "";
    $("foundLocation").value = "";
    $("foundContact").value = "";
    $("foundLookup").hidden = true;
    loadMyItems();
}


// ---------------------------------------------------------------
// 11. Owner: claim the item back
// ---------------------------------------------------------------

async function handleClaim() {
    if (!requireWallet()) return;

    const publicCode = cleanCode($("claimPublicCode").value);
    const secretCode = $("claimSecretCode").value.trim();

    if (!publicCode || !secretCode) {
        showToast("Enter both the public code and your secret code.", "error");
        return;
    }

    const ok = await sendTx($("claimBtn"), () => contract.claimItemAndReset(publicCode, secretCode));
    if (!ok) return;

    showToast("Claimed. Your tag is active again and can be reused.", "success");
    $("claimPublicCode").value = "";
    $("claimSecretCode").value = "";
    await loadMyItems();
    showPage("items");
}


// ---------------------------------------------------------------
// 12. Start-up
// ---------------------------------------------------------------

window.addEventListener("load", async () => {
    setupProvider();
    updateRegisterPreview();

    // The sample tag on the home page
    $("sampleTag").innerHTML = tagHtml("Blue Backpack", "TAG-7KQ4M2XW");

    // Reconnect quietly if this site is already approved in the wallet
    // if (provider) {
    //     try {
    //         const accounts = await provider.send("eth_accounts", []);
    //         if (accounts.length > 0) await setupSigner();
    //     } catch (err) {
    //         console.error(err);
    //     }
    // }

    // Someone scanned a tag: the link looks like ?code=TAG-XXXXXXXX
    const codeFromLink = new URLSearchParams(window.location.search).get("code");
    if (codeFromLink) {
        $("foundPublicCode").value = codeFromLink;
        showPage("found");
        lookUpFoundItem();
    }
});