// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title WritVault
/// @notice Holds Robinhood Chain stock tokens for an owner. An agent may only trade within
///         the owner's written mandate: every decision is bound to the current mandate version
///         and a hash of the SERV reasoning that produced it, and hard limits are enforced here
///         regardless of what the reasoning concluded.
contract WritVault {
    struct Limit {
        bool allowed;
        uint256 maxIn;
    }

    address public immutable owner;
    ISwapRouter02 public immutable router;
    address public immutable weth;

    address public agent;
    bool public paused;

    string public mandate;
    uint64 public mandateVersion;

    mapping(address => Limit) public limits;
    address[] public assets;

    uint32 public maxTradesPerDay;
    uint32 public tradesToday;
    uint64 public currentDay;

    mapping(bytes32 => bool) public decided;

    event MandateSet(uint64 indexed version, string text);
    event LimitSet(address indexed token, bool allowed, uint256 maxIn);
    event AgentSet(address indexed agent);
    event PausedSet(bool paused);
    event Executed(
        bytes32 indexed decisionId,
        uint64 indexed mandateVersion,
        bytes32 reasoningHash,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        string rationale
    );
    event Refused(bytes32 indexed decisionId, uint64 indexed mandateVersion, bytes32 reasoningHash, string rationale);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error AlreadyDecided();
    error StaleMandate(uint64 expected, uint64 given);
    error AssetNotAllowed(address token);
    error OverLimit(uint256 maxIn, uint256 amountIn);
    error DailyLimit(uint32 maxTrades);
    error RationaleTooLong();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(
        address owner_,
        address agent_,
        address router_,
        address weth_,
        uint32 maxTradesPerDay_,
        string memory mandate_,
        address[] memory tokens,
        uint256[] memory maxIns
    ) {
        owner = owner_;
        agent = agent_;
        router = ISwapRouter02(router_);
        weth = weth_;
        maxTradesPerDay = maxTradesPerDay_;
        emit AgentSet(agent_);
        _setMandate(mandate_);
        for (uint256 i = 0; i < tokens.length; i++) {
            _setLimit(tokens[i], true, maxIns[i]);
        }
    }

    receive() external payable {
        IWETH(weth).deposit{value: msg.value}();
    }

    // ---- agent ----

    function execute(
        bytes32 decisionId,
        uint64 version,
        bytes32 reasoningHash,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        string calldata rationale
    ) external onlyAgent returns (uint256 amountOut) {
        _checkDecision(decisionId, version, rationale);
        Limit memory lin = limits[tokenIn];
        if (!lin.allowed) revert AssetNotAllowed(tokenIn);
        if (!limits[tokenOut].allowed) revert AssetNotAllowed(tokenOut);
        if (amountIn > lin.maxIn) revert OverLimit(lin.maxIn, amountIn);

        uint64 today = uint64(block.timestamp / 1 days);
        if (today != currentDay) {
            currentDay = today;
            tradesToday = 0;
        }
        if (tradesToday >= maxTradesPerDay) revert DailyLimit(maxTradesPerDay);
        tradesToday++;

        IERC20(tokenIn).approve(address(router), amountIn);
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit Executed(decisionId, version, reasoningHash, tokenIn, tokenOut, amountIn, amountOut, rationale);
    }

    function refuse(bytes32 decisionId, uint64 version, bytes32 reasoningHash, string calldata rationale)
        external
        onlyAgent
    {
        _checkDecision(decisionId, version, rationale);
        emit Refused(decisionId, version, reasoningHash, rationale);
    }

    // ---- owner ----

    function setMandate(string calldata text) external onlyOwner {
        _setMandate(text);
    }

    function setLimit(address token, bool allowed, uint256 maxIn) external onlyOwner {
        _setLimit(token, allowed, maxIn);
    }

    function setMaxTradesPerDay(uint32 n) external onlyOwner {
        maxTradesPerDay = n;
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
    }

    // ---- views ----

    function assetList() external view returns (address[] memory) {
        return assets;
    }

    // ---- internal ----

    function _checkDecision(bytes32 decisionId, uint64 version, string calldata rationale) internal {
        if (paused) revert IsPaused();
        if (decided[decisionId]) revert AlreadyDecided();
        if (version != mandateVersion) revert StaleMandate(mandateVersion, version);
        if (bytes(rationale).length > 280) revert RationaleTooLong();
        decided[decisionId] = true;
    }

    function _setMandate(string memory text) internal {
        mandate = text;
        mandateVersion++;
        emit MandateSet(mandateVersion, text);
    }

    function _setLimit(address token, bool allowed, uint256 maxIn) internal {
        bool known;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == token) {
                known = true;
                break;
            }
        }
        if (!known) assets.push(token);
        limits[token] = Limit(allowed, maxIn);
        emit LimitSet(token, allowed, maxIn);
    }
}
