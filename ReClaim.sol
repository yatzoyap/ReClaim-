// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LostAndFoundStreamlined
/// @notice Public GPS coordinates, single-step claim & reset, and reusable tags.
contract ReClaim {
    
    // ---------------------------------------------------------------
    // Custom Errors (Gas Optimized)
    // ---------------------------------------------------------------
    error UnknownCode();
    error CodeLengthInvalid();
    error NameLengthInvalid();
    error CodeAlreadyUsed();
    error ItemNotOpen();
    error NotOriginalFinder();
    error LocationInvalid();
    error Unauthorized();
    error InvalidStatus();

    // ---------------------------------------------------------------
    // Data Structures
    // ---------------------------------------------------------------

    // Only two states needed: Tag is active/ready (Registered) or currently found (Found)
    enum Status { Registered, Found }

    struct Item {
        address owner;
        address finder;
        Status status;
        uint32 lat;              // (Latitude + 90) * 1,000,000
        uint32 lng;              // (Longitude + 180) * 1,000,000
        uint64 registeredAt;
        uint64 foundAt;
        string publicCode;       // Dynamic
        string name;             // Dynamic
        string foundLocationName;// Dynamic (e.g., "Central Park")
        string finderContact;    // Dynamic
    }

    // One line of an item's history. Fits in a single storage slot, so it's cheap to write.
    enum Action { Found, Dismissed, Returned }

    struct HistoryEntry {
        Action action;   // what happened
        uint64 timestamp; // when (block timestamp)
        address actor;   // who did it (the finder, or the owner)
    }

    mapping(bytes32 => Item) private items;
    mapping(address => string[]) private ownerCodes;

    // Codes of deleted items. A printed tag with one of these codes can never be
    // registered again, so nobody else can take over an old tag.
    mapping(bytes32 => bool) private retired;

    // History of each item. "Registered" isn't stored here because registeredAt already has it.
    mapping(bytes32 => HistoryEntry[]) private history;

    uint256 public totalItems;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event ItemRegistered(bytes32 indexed id, address indexed owner, string publicCode, string name);
    event ItemFound(bytes32 indexed id, address indexed owner, address indexed finder, string locationName, uint32 lat, uint32 lng);
    event ReportDismissed(bytes32 indexed id, address indexed owner);
    event ItemClaimedAndReset(bytes32 indexed id, address indexed owner, address indexed finder);
    event ItemDeleted(bytes32 indexed id, address indexed owner);

    // ---------------------------------------------------------------
    // Internal Helpers
    // ---------------------------------------------------------------

    function _id(string memory publicCode) private pure returns (bytes32) {
        return keccak256(bytes(publicCode));
    }

    function _load(string memory publicCode) private view returns (bytes32 id, Item storage it) {
        id = _id(publicCode);
        it = items[id];
        if (it.owner == address(0)) revert UnknownCode();
    }

    function _log(bytes32 id, Action action) private {
        history[id].push(HistoryEntry(action, uint64(block.timestamp), msg.sender));
    }

    // Puts the item back to Registered and wipes the finder's report
    function _clearReport(Item storage it) private {
        it.status = Status.Registered;
        it.finder = address(0);
        it.foundLocationName = "";
        it.lat = 0;
        it.lng = 0;
        it.finderContact = "";
        it.foundAt = 0;
    }

    // ---------------------------------------------------------------
    // 1. Register Item
    // ---------------------------------------------------------------

    function registerItem(string calldata publicCode, string calldata name) external {
        if (bytes(publicCode).length < 6 || bytes(publicCode).length > 32) revert CodeLengthInvalid();
        if (bytes(name).length == 0 || bytes(name).length > 60) revert NameLengthInvalid();

        bytes32 id = _id(publicCode);
        if (items[id].owner != address(0) || retired[id]) revert CodeAlreadyUsed();

        Item storage it = items[id];
        it.publicCode = publicCode;
        it.owner = msg.sender;
        it.name = name;
        it.status = Status.Registered;
        it.registeredAt = uint64(block.timestamp);

        ownerCodes[msg.sender].push(publicCode);
        totalItems += 1;

        emit ItemRegistered(id, msg.sender, publicCode, name);
    }

    // ---------------------------------------------------------------
    // 2. Finder Reports Item (Public GPS & Location)
    // ---------------------------------------------------------------

    function reportFound(
        string calldata publicCode,
        string calldata locationName,
        uint32 lat,
        uint32 lng,
        string calldata contact
    ) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (it.status != Status.Registered && it.status != Status.Found) revert ItemNotOpen();
        if (it.status == Status.Found && it.finder != msg.sender) revert NotOriginalFinder();
        if (bytes(locationName).length == 0 || bytes(locationName).length > 100) revert LocationInvalid();
        if (bytes(contact).length > 80) revert LocationInvalid();

        it.status = Status.Found;
        it.finder = msg.sender;
        it.foundLocationName = locationName;
        it.lat = lat;
        it.lng = lng;
        it.finderContact = contact;
        it.foundAt = uint64(block.timestamp);
        _log(id, Action.Found);

        emit ItemFound(id, it.owner, msg.sender, locationName, lat, lng);
    }

    // Owner only
    function dismissReport(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        if (it.status != Status.Found) revert InvalidStatus();
        _clearReport(it);
        _log(id, Action.Dismissed);

        emit ReportDismissed(id, msg.sender);
    }

    // ---------------------------------------------------------------
    // 3. Claim Item & Reset Tag for Reuse (Single Transaction)
    // ---------------------------------------------------------------

    // Owner only
    function claimItemAndReset(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        if (it.status != Status.Found) revert InvalidStatus();
        address finderAddress = it.finder;

        // Reset the item back to Registered so the physical tag can be reused immediately
        _clearReport(it);
        _log(id, Action.Returned);

        emit ItemClaimedAndReset(id, msg.sender, finderAddress);
    }

    // ---------------------------------------------------------------
    // 4. Delete Item (Owner only)
    // ---------------------------------------------------------------

    function deleteItem(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        // Take the code out of the owner's list: move the last one into its place, then pop
        string[] storage codes = ownerCodes[msg.sender];
        for (uint256 i = 0; i < codes.length; i++) {
            if (keccak256(bytes(codes[i])) == id) {
                codes[i] = codes[codes.length - 1];
                codes.pop();
                break;
            }
        }

        delete items[id];
        delete history[id];
        retired[id] = true;
        totalItems -= 1;

        emit ItemDeleted(id, msg.sender);
    }

    // ---------------------------------------------------------------
    // Read-Only Functions (Free Queries)
    // ---------------------------------------------------------------

    function getItem(string calldata publicCode) external view returns (Item memory) {
        return items[_id(publicCode)];
    }

    // Oldest first. Empty if nothing has happened to the item yet.
    function getHistory(string calldata publicCode) external view returns (HistoryEntry[] memory) {
        return history[_id(publicCode)];
    }

    function getOwnerCodes(address owner) external view returns (string[] memory) {
        return ownerCodes[owner];
    }
}