// index.js

let provider, signer, contract;

// Replace with your deployed contract address
const contractAddress = "YOUR_DEPLOYED_CONTRACT_ADDRESS_HERE";

// Contract ABI matching the LostAndFoundStreamlined smart contract
const contractABI = [
    "function registerItem(string publicCode, string name, bytes32 secretHash) external",
    "function reportFound(string publicCode, string locationName, uint32 lat, uint32 lng, string contact) external",
    "function claimItemAndReset(string publicCode, string secretCode) external",
    "function getItem(string publicCode) external view returns (tuple(bytes32 secretHash, address owner, address finder, uint8 status, uint32 lat, uint32 lng, uint64 registeredAt, uint64 foundAt, string publicCode, string name, string foundLocationName, string finderContact))",
    "function getOwnerCodes(address owner) external view returns (string[] memory)"
];

// ---------------------------------------------------------------
// 1. Connect Wallet
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// 2. Register Item (Local Secret Hashing)
// ---------------------------------------------------------------
async function registerItem() {
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

        // Match contract hashing: keccak256(abi.encode(publicCode, secretCode, owner))
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "address"],
            [publicCode, secretCode, ownerAddress]
        );
        const secretHash = ethers.keccak256(encoded);

        const tx = await contract.registerItem(publicCode, name, secretHash);
        console.log("Transaction sent:", tx.hash);
        
        await tx.wait();
        alert("Item registered successfully!");
    } catch (err) {
        console.error(err);
        alert("Error: " + (err.reason || err.message));
    }
}

// ---------------------------------------------------------------
// 3. Report Found (GPS Scaling by 1,000,000)
// ---------------------------------------------------------------
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

    // Scale floats to uint32 integers (preserving 6 decimal places)
    const lat = Math.round(latFloat * 1000000);
    const lng = Math.round(lngFloat * 1000000);

    try {
        const tx = await contract.reportFound(publicCode, locationName, lat, lng, contact);
        console.log("Transaction sent:", tx.hash);

        await tx.wait();
        alert("Item reported found!");
    } catch (err) {
        console.error(err);
        alert("Error: " + (err.reason || err.message));
    }
}

// ---------------------------------------------------------------
// 4. Claim & Reset Tag
// ---------------------------------------------------------------
async function claimItem() {
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
        alert("Item claimed successfully and tag reset for future use!");
    } catch (err) {
        console.error(err);
        alert("Error: " + (err.reason || err.message));
    }
}