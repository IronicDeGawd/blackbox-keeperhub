// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChaosTarget} from "../src/ChaosTarget.sol";
import {CircuitBreaker} from "../src/CircuitBreaker.sol";

contract ChaosTargetTest is Test {
    ChaosTarget target;
    CircuitBreaker breaker;

    address constant BLACKBOX = address(0xB1AC);
    address constant OPERATOR = address(0x00E4);

    function setUp() public {
        vm.prank(OPERATOR);
        breaker = new CircuitBreaker(OPERATOR);
        target = new ChaosTarget(address(breaker));
    }

    /// The whole point of C3: same call, same arguments, different block.
    function test_trapDoesNotSpringInTheBlockItWasArmed() public {
        target.armTrap();
        target.work();
        assertEq(target.workCount(), 1);
    }

    function test_trapSpringsOnceABlockHasPassed() public {
        target.armTrap();
        uint256 armedAt = block.number;
        vm.roll(block.number + 1);

        vm.expectRevert(
            abi.encodeWithSelector(ChaosTarget.TrapSprung.selector, armedAt, block.number)
        );
        target.work();
    }

    function test_disarmRestoresNormalOperation() public {
        target.armTrap();
        vm.roll(block.number + 1);
        target.disarm();
        target.work();
        assertEq(target.workCount(), 1);
    }

    function test_alwaysRevertNeverSucceeds() public {
        vm.expectRevert(ChaosTarget.AlwaysReverts.selector);
        target.alwaysRevert();
    }

    /// R7: the swap succeeds, but at a price the caller never agreed to.
    function test_swapExecutesAtTheMovedPrice() public {
        target.movePrice(2 ether);
        uint256 executed = target.swap(1 ether);
        assertEq(executed, 2 ether);
    }

    function test_swapWithLimitRevertsRatherThanExecutingBadly() public {
        target.movePrice(2 ether);
        vm.expectRevert(
            abi.encodeWithSelector(ChaosTarget.PriceTooHigh.selector, 2 ether, 1 ether)
        );
        target.swapWithLimit(1 ether);
    }

    /// P4 end to end: Blackbox pauses, and the agent's work stops.
    function test_pausedBreakerHaltsWork() public {
        vm.prank(OPERATOR);
        breaker.setPauser(BLACKBOX, true);
        vm.prank(BLACKBOX);
        breaker.pause();

        vm.expectRevert(ChaosTarget.BreakerPaused.selector);
        target.work();
    }

    function test_workResumesAfterTheOwnerUnpauses() public {
        vm.startPrank(OPERATOR);
        breaker.pause();
        breaker.unpause();
        vm.stopPrank();

        target.work();
        assertEq(target.workCount(), 1);
    }

    function test_targetWithNoBreakerIsUnaffected() public {
        ChaosTarget bare = new ChaosTarget(address(0));
        bare.work();
        assertEq(bare.workCount(), 1);
    }
}
