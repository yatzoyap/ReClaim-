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
    error MissingSecretHash();
    error CodeAlreadyUsed();
    error ItemNotOpen();
    error NotOriginalFinder();
    error LocationInvalid();
    error Unauthorized();
    error WrongSecretCode();
    error InvalidStatus();

    // ---------------------------------------------------------------
    // Data Structures
    // ---------------------------------------------------------------

    // Only two states needed: Tag is active/ready (Registered) or currently found (Found)
    enum Status { Registered, Found }

    struct Item {
        bytes32 secretHash;      // Slot 0 (32 bytes)
        address owner;           // Slot 1 (20 bytes)
        address finder;          // Slot 2 (20 bytes) 
        Status status;           // Slot 2 (1 byte) 
        uint32 lat;              // Slot 2 (4 bytes) - Latitude * 1^6
        uint32 lng;              // Slot 2 (4 bytes) - Longitude * 1^6
        uint64 registeredAt;     // Slot 2 (8 bytes)
        uint64 foundAt;          // Slot 2 (8 bytes) 
        string publicCode;       // Dynamic
        string name;             // Dynamic
        string foundLocationName;// Dynamic (e.g., "Central Park")
        string finderContact;    // Dynamic
    }

    mapping(bytes32 => Item) private items;
    mapping(address => string[]) private ownerCodes;

    uint256 public totalItems;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event ItemRegistered(bytes32 indexed id, address indexed owner, string publicCode, string name);
    event ItemFound(bytes32 indexed id, address indexed owner, address indexed finder, string locationName, uint32 lat, uint32 lng);
    event ReportDismissed(bytes32 indexed id, address indexed owner);
    event ItemClaimedAndReset(bytes32 indexed id, address indexed owner, address indexed finder);

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

    // ---------------------------------------------------------------
    // 1. Register Item
    // ---------------------------------------------------------------

    function registerItem(
        string calldata publicCode,
        string calldata name,
        bytes32 secretHash
    ) external {
        if (bytes(publicCode).length < 6 || bytes(publicCode).length > 32) revert CodeLengthInvalid();
        if (bytes(name).length == 0 || bytes(name).length > 60) revert NameLengthInvalid();
        if (secretHash == bytes32(0)) revert MissingSecretHash();

        bytes32 id = _id(publicCode);
        if (items[id].owner != address(0)) revert CodeAlreadyUsed();

        Item storage it = items[id];
        it.publicCode = publicCode;
        it.owner = msg.sender;
        it.name = name;
        it.secretHash = secretHash;
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

        emit ItemFound(id, it.owner, msg.sender, locationName, lat, lng);
    }

    function dismissReport(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        if (it.status != Status.Found) revert InvalidStatus();

        it.status = Status.Registered;
        it.finder = address(0);
        it.foundLocationName = "";
        it.lat = 0;
        it.lng = 0;
        it.finderContact = "";
        it.foundAt = 0;

        emit ReportDismissed(id, msg.sender);
    }

    // ---------------------------------------------------------------
    // 3. Claim Item & Reset Tag for Reuse (Single Transaction)
    // ---------------------------------------------------------------

    function claimItemAndReset(string calldata publicCode, string calldata secretCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        if (it.status != Status.Found) revert InvalidStatus();
        if (keccak256(abi.encode(publicCode, secretCode, msg.sender)) != it.secretHash) {
            revert WrongSecretCode();
        }

        address finderAddress = it.finder;

        // Reset the item back to Registered so the physical tag can be reused immediately
        it.status = Status.Registered;
        it.finder = address(0);
        it.foundLocationName = "";
        it.lat = 0;
        it.lng = 0;
        it.finderContact = "";
        it.foundAt = 0;

        emit ItemClaimedAndReset(id, msg.sender, finderAddress);
    }

    // ---------------------------------------------------------------
    // Read-Only Functions (Free Queries)
    // ---------------------------------------------------------------

    function getItem(string calldata publicCode) external view returns (Item memory) {
        return items[_id(publicCode)];
    }

    function getOwnerCodes(address owner) external view returns (string[] memory) {
        return ownerCodes[owner];
    }
}