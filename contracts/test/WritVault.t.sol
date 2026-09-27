// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WritVault, IERC20} from "../src/WritVault.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
}

/// Run against Robinhood Chain testnet:
/// forge test --fork-url https://rpc.testnet.chain.robinhood.com
contract WritVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant ROUTER = 0x3Ce954107b1A675826B33bF23060Dd655e3758fE;
    address constant WETH = 0x33e4191705c386532ba27cBF171Db86919200B94;
    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;

    address owner = address(0xA11CE);
    address agent = address(0xB0B);
    WritVault vault;

    function setUp() public {
        address[] memory tokens = new address[](3);
        uint256[] memory maxIns = new uint256[](3);
        tokens[0] = WETH;
        maxIns[0] = 0.001 ether;
        tokens[1] = TSLA;
        maxIns[1] = 1 ether;
        tokens[2] = AMZN;
        maxIns[2] = 1 ether;
        vault = new WritVault(owner, agent, ROUTER, WETH, 2, "Buy TSLA on dips.", tokens, maxIns);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 0.01 ether}("");
        require(ok, "fund");
    }

    function _exec(bytes32 id, uint64 ver, address tin, address tout, uint256 amt) internal returns (uint256) {
        vm.prank(agent);
        return vault.execute(id, ver, keccak256("r"), tin, tout, 3000, amt, 0, "within mandate");
    }

    function test_executesWithinMandate() public {
        uint256 before = IERC20(TSLA).balanceOf(address(vault));
        uint256 out = _exec("d1", 1, WETH, TSLA, 0.001 ether);
        require(out > 0, "no output");
        require(IERC20(TSLA).balanceOf(address(vault)) == before + out, "balance");
    }

    function test_rejectsOverLimit() public {
        vm.expectRevert(abi.encodeWithSelector(WritVault.OverLimit.selector, 0.001 ether, 0.002 ether));
        _exec("d1", 1, WETH, TSLA, 0.002 ether);
    }

    function test_rejectsAssetOutsideMandate() public {
        vm.expectRevert(abi.encodeWithSelector(WritVault.AssetNotAllowed.selector, NFLX));
        _exec("d1", 1, WETH, NFLX, 0.001 ether);
    }

    function test_rejectsStaleMandate() public {
        vm.prank(owner);
        vault.setMandate("Hold only.");
        vm.expectRevert(abi.encodeWithSelector(WritVault.StaleMandate.selector, uint64(2), uint64(1)));
        _exec("d1", 1, WETH, TSLA, 0.001 ether);
    }

    function test_rejectsReplay() public {
        _exec("d1", 1, WETH, TSLA, 0.001 ether);
        vm.expectRevert(abi.encodeWithSelector(WritVault.AlreadyDecided.selector));
        _exec("d1", 1, WETH, TSLA, 0.001 ether);
    }

    function test_rejectsDailyLimit() public {
        _exec("d1", 1, WETH, TSLA, 0.001 ether);
        _exec("d2", 1, WETH, TSLA, 0.001 ether);
        vm.expectRevert(abi.encodeWithSelector(WritVault.DailyLimit.selector, uint32(2)));
        _exec("d3", 1, WETH, TSLA, 0.001 ether);
    }

    function test_rejectsNonAgent() public {
        vm.expectRevert(abi.encodeWithSelector(WritVault.NotAgent.selector));
        vault.execute("d1", 1, keccak256("r"), WETH, TSLA, 3000, 0.001 ether, 0, "x");
    }

    function test_pauseBlocksAgent() public {
        vm.prank(owner);
        vault.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(WritVault.IsPaused.selector));
        _exec("d1", 1, WETH, TSLA, 0.001 ether);
    }

    function test_refusalIsRecordedOnce() public {
        vm.prank(agent);
        vault.refuse("d9", 1, keccak256("r"), "NFLX is outside the mandate");
        require(vault.decided("d9"), "not recorded");
        vm.expectRevert(abi.encodeWithSelector(WritVault.AlreadyDecided.selector));
        vm.prank(agent);
        vault.refuse("d9", 1, keccak256("r"), "again");
    }

    function test_ownerWithdraws() public {
        vm.prank(owner);
        vault.withdraw(WETH, 0.005 ether);
        require(IERC20(WETH).balanceOf(owner) == 0.005 ether, "withdraw");
    }
}
