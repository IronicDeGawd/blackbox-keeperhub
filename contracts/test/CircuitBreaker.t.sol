// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CircuitBreaker} from "../src/CircuitBreaker.sol";

contract CircuitBreakerTest is Test {
    CircuitBreaker breaker;

    address constant OWNER = address(0x00BE);
    address constant BLACKBOX = address(0xB1AC);
    address constant STRANGER = address(0x05EE);

    function setUp() public {
        breaker = new CircuitBreaker(OWNER);
    }

    function test_pauseSelectorMatchesTheWellKnownOne() public pure {
        // Playbook P4 submits this selector directly, and an operator may point
        // Blackbox at any OpenZeppelin Pausable instead of this contract.
        assertEq(bytes4(keccak256("pause()")), bytes4(0x8456cb59));
    }

    function test_ownerCanPause() public {
        vm.prank(OWNER);
        breaker.pause();
        assertTrue(breaker.isPaused());
        assertTrue(breaker.paused());
    }

    function test_grantedPauserCanPause() public {
        vm.prank(OWNER);
        breaker.setPauser(BLACKBOX, true);

        vm.prank(BLACKBOX);
        breaker.pause();
        assertTrue(breaker.isPaused());
    }

    function test_strangerCannotPause() public {
        vm.prank(STRANGER);
        vm.expectRevert(CircuitBreaker.NotPauser.selector);
        breaker.pause();
    }

    /// The asymmetry that makes granting halt authority safe.
    function test_pauserCannotUnpause() public {
        vm.prank(OWNER);
        breaker.setPauser(BLACKBOX, true);
        vm.prank(BLACKBOX);
        breaker.pause();

        vm.prank(BLACKBOX);
        vm.expectRevert(CircuitBreaker.NotOwner.selector);
        breaker.unpause();
    }

    function test_pauserCannotGrantItselfMoreAuthority() public {
        vm.prank(OWNER);
        breaker.setPauser(BLACKBOX, true);

        vm.startPrank(BLACKBOX);
        vm.expectRevert(CircuitBreaker.NotOwner.selector);
        breaker.setPauser(BLACKBOX, true);
        vm.expectRevert(CircuitBreaker.NotOwner.selector);
        breaker.transferOwnership(BLACKBOX);
        vm.stopPrank();
    }

    function test_revokedPauserLosesTheAbility() public {
        vm.startPrank(OWNER);
        breaker.setPauser(BLACKBOX, true);
        breaker.setPauser(BLACKBOX, false);
        vm.stopPrank();

        vm.prank(BLACKBOX);
        vm.expectRevert(CircuitBreaker.NotPauser.selector);
        breaker.pause();
    }

    function test_pausingTwiceIsRejected() public {
        vm.startPrank(OWNER);
        breaker.pause();
        vm.expectRevert(CircuitBreaker.AlreadyInThatState.selector);
        breaker.pause();
        vm.stopPrank();
    }

    function test_pauseWithReasonRecordsWhy() public {
        vm.expectEmit(true, false, false, true);
        emit CircuitBreaker.Paused(OWNER, "retry storm on agent chaos");

        vm.prank(OWNER);
        breaker.pauseWithReason("retry storm on agent chaos");
    }

    function test_constructorDefaultsOwnerToDeployer() public {
        CircuitBreaker b = new CircuitBreaker(address(0));
        assertEq(b.owner(), address(this));
    }
}
