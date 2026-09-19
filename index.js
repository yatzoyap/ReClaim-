// index.js

// --- 1. UI Navigation & Dashboard Logic ---
let localItems = [];

function showPage(pageId) {
    document.querySelectorAll('.page-section').forEach(sec => sec.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
    
    document.querySelectorAll('.nav-links a').forEach(link => link.classList.remove('active'));
    document.getElementById(`nav-${pageId}`).classList.add('active');
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateFloatingPanel() {
    const list = document.getElementById("items-list");
    if (localItems.length === 0) {
        list.innerHTML = '<p style="font-size: 0.9rem; color: var(--text-muted);">No items registered yet.</p>';
        return;
    }
    
    list.innerHTML = '';
    localItems.forEach(item => {
        list.innerHTML += `
            <div class="registered-item">
                <strong>${item.name}</strong> (${item.code})<br>
                <span class="status-badge" style="background: ${item.status === 'Found' ? '#ef4444' : 'var(--primary)'}">${item.status}</span>
            </div>
        `;
    });
}

function generatePublicCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "TAG-";
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const regInput = document.getElementById("regPublicCode");
    if(regInput) regInput.value = result;
}

// --- 2. Web3 & Smart Contract Logic ---
let provider, signer, contract;

// TODO: Replace this with your actual deployed ReClaim.sol address from Remix!
const contractAddress = "0xf29614100602bEbc020B752285725Eb5bF4decb7";

// ABI updated to include all functions from ReClaim.sol
const contractABI = [
    "function registerItem(string publicCode, string name, bytes32 secretHash) external",
    "function reportFound(string publicCode, string locationName, uint32 lat, uint32 lng, string contact) external",
    "function claimItemAndReset(string publicCode, string secretCode) external",
    "function dismissReport(string publicCode) external",
    "function getItem(string publicCode) external view returns (tuple(bytes32 secretHash, address owner, address finder, uint8 status, uint32 lat, uint32 lng, uint64 registeredAt, uint64 foundAt, string publicCode, string name, string foundLocationName, string finderContact))",
    "function getOwnerCodes(address owner) external view returns (string[] memory)"
];

async function connectWallet() {
    if (window.ethereum) {
        try {
            provider = new ethers.BrowserProvider(window.ethereum);
            signer = await provider.getSigner();
            contract = new ethers.Contract(contractAddress, contractABI, signer);
            
            const address = await signer.getAddress();
            const walletElement = document.getElementById("walletAddress");
            if (walletElement) {
                walletElement.innerText = "Wallet: " + address;
            }
            console.log("Connected to wallet:", address);
        } catch (err) {
            console.error("User denied wallet connection:", err);
        }
    } else {
        alert("Please install MetaMask or another Web3 wallet!");
    }
}

async function handleRegistration() {
    if (!contract) {
        alert("Please connect your wallet first!");
        return;
    }

    const publicCode = document.getElementById("regPublicCode").value;
    const name = document.getElementById("regName").value;
    const secretCode = document.getElementById("regSecretCode").value;
    
    if (!publicCode || !name || !secretCode) {
        alert("Please fill in all registration fields.");
        return;
    }

    try {
        const ownerAddress = await signer.getAddress();
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "address"],
            [publicCode, secretCode, ownerAddress]
        );
        const secretHash = ethers.keccak256(encoded);

        const tx = await contract.registerItem(publicCode, name, secretHash);
        console.log("Transaction sent:", tx.hash);
        
        await tx.wait();
        
        // Update Frontend UI
        localItems.push({ name: name, code: publicCode, status: 'Registered' });
        updateFloatingPanel();
        alert("Item registered successfully! Public Code: " + publicCode);
    } catch (err) {
        console.error(err);
        alert("Error: " + (err.reason || err.message));
    }
}

async function reportFound() {
    if (!contract) {
        alert("Please connect your wallet first!");
        return;
    }

    const publicCode = document.getElementById("foundPublicCode").value;
    const locationName = document.getElementById("foundLocation").value;
    const latFloat = parseFloat(document.getElementById("foundLat").value);
    const lngFloat = parseFloat(document.getElementById("foundLng").value);
    const contact = document.getElementById("foundContact").value || "";

    if (!publicCode || !locationName || isNaN(latFloat) || isNaN(lngFloat)) {
        alert("Please provide a valid public code, location name, and coordinates.");
        return;
    }

    const lat = Math.round(latFloat * 1000000);
    const lng = Math.round(lngFloat * 1000000);

    try {
        const tx = await contract.reportFound(publicCode, locationName, lat, lng, contact);
        console.log("Transaction sent:", tx.hash);

        await tx.wait();
        
        // Update Frontend UI
        let item = localItems.find(i => i.code === publicCode);
        if(item) {
            item.status = 'Found';
            updateFloatingPanel();
        }
        alert("Item reported found!");
    } catch (err) {
        console.error(err);
        alert("Error: " + (err.reason || err.message));
    }
}

async function handleClaim() {
    if (!contract) {
        alert("Please connect your wallet first!");
        return;
    }

    const publicCode = document.getElementById("claimPublicCode").value;
    const secretCode = document.getElementById("claimSecretCode").value;

    if (!publicCode || !secretCode) {
        alert("Please provide both the public code and your secret code.");
        return;
    }

    try {
        const tx = await contract.claimItemAndReset(publicCode, secretCode);
        console.log("Transaction sent:", tx.hash);

        await tx.wait();
        
        // Update Frontend UI
        let item = localItems.find(i => i.code === publicCode);
        if(item) {
            item.status = 'Registered';
            updateFloatingPanel();
        }
        alert("Item claimed successfully and tag reset for future use!");
    } catch (err) {
        console.error(err);
        alert("Error: " + (err.reason || err.message));
    }
}