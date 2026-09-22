# ReClaim: Decentralized Lost and Found on BOT Chain

**ReClaim** is a lightweight, decentralized lost-and-found DApp built on **BOT Chain**. It allows anyone to register physical belongings, print physical QR tags, and attach them to items like bags, keys, or electronics. When an item is lost and found, the finder scans the QR tag to report its GPS location and details directly to the blockchain—no intermediary company, user account creation, or centralized database required.

---

## 💡 What ReClaim Does

Traditional lost-and-found systems rely on centralized web platforms or private databases. If the company shuts down or charges fees, the tags become useless. 

**ReClaim solves this by putting lost-and-found records on-chain:**

1. **Tag & Track**: Register an item using your Web3 wallet and generate a printable physical QR tag.
2. **Find & Report**: Anyone who finds your lost item can scan the tag and drop an exact GPS pin and location note on an interactive map.
3. **Claim & Reuse**: Once reunited with your item, claiming it resets the status back to *Registered*, making the physical tag immediately reusable for the next time without re-printing.

---

## ✨ Key Features

- **Decentralized & Perpetual**: All records are stored on the BOT Chain smart contract. No central server or subscription needed.
- **Reusable Physical Tags**: Claiming an item automatically resets the state on-chain, meaning a single physical QR tag can be reused indefinitely.
- **Interactive Map & GPS Coordinates**: Built-in Leaflet and OpenStreetMap integration allowing finders to pinpoint precise location coordinates (encoded into contract-friendly integers).
- **Full On-Chain Audit History**: Track every event in an item's lifecycle (*Registered*, *Reported Found*, *Report Dismissed*, *Returned to Owner*).
- **Owner Governance**: Owners can dismiss false/spam reports or permanently retire/delete an item code.
- **Zero Account Creation**: Operates natively via MetaMask or any Web3 browser/wallet.

---

## 🛠️ Architecture & Tech Stack

ReClaim is built with a minimalist, single-file architecture to ensure maximum transparency, speed, and ease of deployment.

- **Smart Contract**: Solidity (`^0.8.20`) deployed on **BOT Chain**. Optimized for gas efficiency using custom errors, compact struct packing, and string-indexed storage.
- **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES6+).
- **Web3 Integration**: [ethers.js v6](https://docs.ethers.org/v6/) for smart contract interaction.
- **Mapping & Geolocation**: [Leaflet.js](https://leafletjs.com/) with [OpenStreetMap](https://www.openstreetmap.org/) tile integration and Nominatim reverse geocoding.
- **QR Generation**: In-browser client-side SVG QR code generator library.

---

## 📋 How to Use

### 1. For Item Owners

1. **Connect Wallet**: Open the DApp and connect your MetaMask or Web3 wallet.
2. **Register an Item**: Go to **Register**, give your item a recognizable name (e.g., *"Blue Jansport Backpack"*), and click **Register Item**.
3. **Print Tag**: Click **Print Tag** to print the physical tag containing the QR code and unique public code (`TAG-XXXXXXXX`), then attach it to your item.
4. **Claim Item**: If your item is found and reported, navigate to **My Items** or **Claim**, inspect the location map, and click **Claim Item** once returned.

### 2. For Finders

1. **Scan Tag**: Use any smartphone camera to scan the QR code on the physical tag, or manually enter the public code (`TAG-XXXXXXXX`) on the **I Found Something** tab.
2. **Set Location**: Type a location name or search using the map tool, then drop an exact pin on the interactive map (or click *Use My Location*).
3. **Submit Report**: Optionally add contact info (E-Mail, social handle) and click **Report as Found**.

---

## 🚀 Deployment

| Network | Contract Address | Explorer Link |
| :--- | :--- | :--- |
| **BOT Chain Testnet (Chain ID 968)** | `0x4e151bEC8ee2287dc397Ac46596C53440F684b85` | [View on Explorer](https://scan.botchain.ai/address/0x4e151bEC8ee2287dc397Ac46596C53440F684b85) |
| **BOT Chain Mainnet (Chain ID 677)** | `0x4e151bEC8ee2287dc397Ac46596C53440F684b85` | [View on Explorer](https://scan.botchain.ai/) |


---

## 📄 Smart Contract Methods (`ReClaim.sol`)

- `registerItem(string publicCode, string name)`: Registers a new item owned by `msg.sender`.
- `reportFound(string publicCode, string locationName, uint32 lat, uint32 lng, string contact)`: Logs a found report with coordinates and contact details.
- `claimItemAndReset(string publicCode)`: Allows the owner to clear the report and reset the tag for reuse.
- `dismissReport(string publicCode)`: Allows the owner to dismiss inaccurate or spam reports.
- `deleteItem(string publicCode)`: Permanently deletes an item and retires its public code.
- `getItem(string publicCode)`: View function returning complete item details.
- `getHistory(string publicCode)`: View function returning event history logs.
- `getOwnerCodes(address owner)`: Returns all public codes registered by a specific wallet.

---

## 📜 License

This project is open-source and available under the [MIT License](LICENSE).