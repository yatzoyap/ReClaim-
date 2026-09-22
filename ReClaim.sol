// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ReClaim
/// @notice Gas-optimized lost-and-found contract with reusable physical tags.
contract ReClaim {
    
    // ---------------------------------------------------------------
    // Custom Errors
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
    // Data Structures & Storage Packing
    // ---------------------------------------------------------------

    enum Status { Registered, Found }
    enum Action { Found, Dismissed, Returned }

    // Tightly packed: Fields reordered to fill exact 32-byte storage slots
    struct Item {
        // Slot 0: 20 + 8 + 4 = 32 bytes (Full slot)
        address owner;          
        uint64 registeredAt;    
        uint32 lat;             

        // Slot 1: 20 + 8 + 4 = 32 bytes (Full slot)
        address finder;         
        uint64 foundAt;         
        uint32 lng;             

        // Slot 2: 1 byte
        Status status;          

        // Dynamic storage slots
        string publicCode;      
        string name;            
        string foundLocationName;
        string finderContact;   
    }

    struct HistoryEntry {
        Action action;    // 1 byte
        uint64 timestamp; // 8 bytes
        address actor;    // 20 bytes (Total: 29 bytes, fits in 1 slot)
    }

    mapping(bytes32 => Item) private items;
    mapping(address => string[]) private ownerCodes;
    
    // 1-based index mapping for O(1) swap-and-pop deletion
    mapping(bytes32 => uint256) private ownerCodeIndex;

    mapping(bytes32 => bool) private retired;
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

    // Accepts calldata to prevent copying dynamic strings to memory
    function _id(string calldata publicCode) private pure returns (bytes32) {
        return keccak256(bytes(publicCode));
    }

    function _load(string calldata publicCode) private view returns (bytes32 id, Item storage it) {
        id = _id(publicCode);
        it = items[id];
        if (it.owner == address(0)) revert UnknownCode();
    }

    function _log(bytes32 id, Action action) private {
        history[id].push(HistoryEntry(action, uint64(block.timestamp), msg.sender));
    }

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
    // Core Functions
    // ---------------------------------------------------------------

    function registerItem(string calldata publicCode, string calldata name) external {
        uint256 codeLen = bytes(publicCode).length;
        if (codeLen < 6 || codeLen > 32) revert CodeLengthInvalid();
        
        uint256 nameLen = bytes(name).length;
        if (nameLen == 0 || nameLen > 60) revert NameLengthInvalid();

        bytes32 id = _id(publicCode);
        if (items[id].owner != address(0) || retired[id]) revert CodeAlreadyUsed();

        Item storage it = items[id];
        it.publicCode = publicCode;
        it.owner = msg.sender;
        it.name = name;
        it.status = Status.Registered;
        it.registeredAt = uint64(block.timestamp);

        ownerCodes[msg.sender].push(publicCode);
        // Track 1-based index (0 indicates unassigned)
        ownerCodeIndex[id] = ownerCodes[msg.sender].length;
        
        unchecked {
            ++totalItems;
        }

        emit ItemRegistered(id, msg.sender, publicCode, name);
    }

    function reportFound(
        string calldata publicCode,
        string calldata locationName,
        uint32 lat,
        uint32 lng,
        string calldata contact
    ) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        
        // Removed redundant enum status check
        if (it.status == Status.Found && it.finder != msg.sender) revert NotOriginalFinder();
        
        uint256 locLen = bytes(locationName).length;
        if (locLen == 0 || locLen > 100) revert LocationInvalid();
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

    function dismissReport(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        if (it.status != Status.Found) revert InvalidStatus();
        
        _clearReport(it);
        _log(id, Action.Dismissed);

        emit ReportDismissed(id, msg.sender);
    }

    function claimItemAndReset(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();
        if (it.status != Status.Found) revert InvalidStatus();
        
        address finderAddress = it.finder;

        _clearReport(it);
        _log(id, Action.Returned);

        emit ItemClaimedAndReset(id, msg.sender, finderAddress);
    }

    function deleteItem(string calldata publicCode) external {
        (bytes32 id, Item storage it) = _load(publicCode);
        if (msg.sender != it.owner) revert Unauthorized();

        // O(1) Constant Time Array Swap-and-Pop
        uint256 indexToRemove = ownerCodeIndex[id] - 1;
        string[] storage codes = ownerCodes[msg.sender];
        uint256 lastIndex = codes.length - 1;

        if (indexToRemove != lastIndex) {
            string storage lastCode = codes[lastIndex];
            codes[indexToRemove] = lastCode;
            ownerCodeIndex[keccak256(bytes(lastCode))] = indexToRemove + 1;
        }

        codes.pop();
        delete ownerCodeIndex[id];

        delete items[id];
        delete history[id];
        retired[id] = true;
        
        unchecked {
            --totalItems;
        }

        emit ItemDeleted(id, msg.sender);
    }

    // ---------------------------------------------------------------
    // Read-Only Functions
    // ---------------------------------------------------------------

    function getItem(string calldata publicCode) external view returns (Item memory) {
        return items[keccak256(bytes(publicCode))];
    }

    function getHistory(string calldata publicCode) external view returns (HistoryEntry[] memory) {
        return history[keccak256(bytes(publicCode))];
    }

    function getOwnerCodes(address owner) external view returns (string[] memory) {
        return ownerCodes[owner];
    }
}