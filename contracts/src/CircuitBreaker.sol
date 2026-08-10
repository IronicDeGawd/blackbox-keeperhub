// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Reference circuit breaker.
 *
 * This is the contract an agent integrates to enable playbook P4: when Blackbox
 * concludes an agent is failing repeatedly, it calls `pause()` here and the
 * agent's own contracts stop accepting work. Blackbox never gains any power
 * beyond that one call — it cannot unpause, cannot change roles, and cannot
 * touch funds. That asymmetry is the point: granting halt authority has to be
 * safe enough that an operator will actually do it.
 *
 * Integration is two lines. Hold a breaker address, and guard the entry points
 * that spend money:
 *
 *     if (breaker.isPaused()) revert Paused();
 *
 * `pause()` deliberately takes no arguments so its selector is the well-known
 * `0x8456cb59`, matching OpenZeppelin's Pausable. An operator can therefore
 * point Blackbox at an existing pausable contract without deploying this one.
 */
contract CircuitBreaker {
    /// Emitted on every state change, so the timeline can show who halted what.
    event Paused(address indexed by, string reason);
    event Unpaused(address indexed by);
    event PauserUpdated(address indexed pauser, bool allowed);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPauser();
    error AlreadyInThatState();

    address public owner;
    bool public isPaused;

    /// Addresses permitted to pause. Blackbox's signer goes here.
    mapping(address => bool) public isPauser;

    constructor(address initialOwner) {
        owner = initialOwner == address(0) ? msg.sender : initialOwner;
        emit OwnerTransferred(address(0), owner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * Halt.
     *
     * Any pauser may call this, and the owner always may. Unpausing is
     * deliberately owner-only: an automated system should be able to stop the
     * bleeding without also being able to declare the problem over.
     */
    function pause() external {
        if (msg.sender != owner && !isPauser[msg.sender]) revert NotPauser();
        if (isPaused) revert AlreadyInThatState();
        isPaused = true;
        emit Paused(msg.sender, "");
    }

    /// Halt, recording why. Same authority as `pause()`.
    function pauseWithReason(string calldata reason) external {
        if (msg.sender != owner && !isPauser[msg.sender]) revert NotPauser();
        if (isPaused) revert AlreadyInThatState();
        isPaused = true;
        emit Paused(msg.sender, reason);
    }

    function unpause() external onlyOwner {
        if (!isPaused) revert AlreadyInThatState();
        isPaused = false;
        emit Unpaused(msg.sender);
    }

    function setPauser(address pauser, bool allowed) external onlyOwner {
        isPauser[pauser] = allowed;
        emit PauserUpdated(pauser, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// Named for the common `paused()` accessor, so existing guards compile.
    function paused() external view returns (bool) {
        return isPaused;
    }
}
