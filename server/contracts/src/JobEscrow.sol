// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IJobAuthority {
    function hasWorkerGrant(bytes32 jobId, address worker) external view returns (bool);
}

/// @notice Minimal, non-upgradeable BATON escrow for fixed-price milestone work.
/// Reward credits are immutable once accepted and remain claimable after handoff/closure.
contract JobEscrow is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    bytes32 private constant OFFER_TYPEHASH = keccak256(
        "MilestoneOffer(bytes32 jobId,bytes32 taskId,bytes32 termsHash,address producer,uint64 epoch,uint32 milestone,bytes32 acceptanceSpecHash,bytes32 expectedHead,bytes32 newHead,string manifestRef,uint64 sequence,uint256 nonce,uint64 expiry)"
    );
    bytes32 private constant TAKEOVER_TYPEHASH = keccak256(
        "TakeoverAck(bytes32 jobId,bytes32 taskId,bytes32 termsHash,address successor,uint64 epoch,bytes32 expectedHead,bytes32 compatibilityReport,bytes32 servicePolicy,uint256 nonce,uint64 expiry)"
    );
    bytes32 public constant EMPTY_HEAD = bytes32(0);
    bytes32 public constant PROTOCOL_VERSION = keccak256("BATON_JOB_ESCROW_V2");

    error Unauthorized();
    error InvalidTerms();
    error InvalidWorkerGrant();
    error InvalidSignature();
    error SignatureExpired();
    error Replay();
    error StaleHead();
    error StaleEpoch();
    error InvalidMilestone();
    error NotOpen();
    error NotDrained();
    error AlreadyClosed();
    error NothingToClaim();
    error TransferFailed();
    error DeadlinePassed();

    struct Job {
        address buyer;
        IERC20 rewardToken;
        IJobAuthority authority;
        address verifier;
        bytes32 termsHash;
        bytes32 taskId;
        uint256 rewardPool;
        uint64 cutoff;
        uint64 epoch;
        uint32 nextMilestone;
        address assignedWorker;
        bytes32 acceptedHead;
        uint256 unallocated;
        bool paused;
        bool drained;
        bool closed;
        uint256 totalCredited;
        uint256 totalWithdrawn;
        uint256 totalRefunded;
    }

    struct Milestone {
        uint256 reward;
        bytes32 acceptanceSpecHash;
    }

    struct MilestoneOffer {
        bytes32 jobId;
        bytes32 taskId;
        bytes32 termsHash;
        address producer;
        uint64 epoch;
        uint32 milestone;
        bytes32 acceptanceSpecHash;
        bytes32 expectedHead;
        bytes32 newHead;
        string manifestRef;
        uint64 sequence;
        uint256 nonce;
        uint64 expiry;
    }

    struct TakeoverAck {
        bytes32 jobId;
        bytes32 taskId;
        bytes32 termsHash;
        address successor;
        uint64 epoch;
        bytes32 expectedHead;
        bytes32 compatibilityReport;
        bytes32 servicePolicy;
        uint256 nonce;
        uint64 expiry;
    }

    mapping(bytes32 => Job) public jobs;
    mapping(bytes32 => Milestone[]) private milestones;
    mapping(bytes32 => mapping(address => uint256)) public credits;
    mapping(bytes32 => mapping(address => uint256)) public withdrawnCredits;
    mapping(bytes32 => uint64) public acceptedSequences;
    mapping(bytes32 => string) public acceptedManifestRefs;
    mapping(bytes32 => mapping(uint256 => bool)) public usedNonces;

    event JobFunded(bytes32 indexed jobId, address indexed buyer, uint256 amount);
    event TaskAssigned(bytes32 indexed jobId, address indexed worker, uint64 epoch);
    event MilestoneAccepted(bytes32 indexed jobId, uint32 indexed milestone, address indexed producer, bytes32 newHead, uint64 sequence, string manifestRef, uint256 reward);
    event TaskTakenOver(bytes32 indexed jobId, address indexed previousWorker, address indexed successor, uint64 epoch);
    event TaskDrainCancelled(bytes32 indexed jobId);
    event JobPaused(bytes32 indexed jobId);
    event JobResumed(bytes32 indexed jobId);
    event JobClosed(bytes32 indexed jobId, uint256 refund);
    event RewardClaimed(bytes32 indexed jobId, address indexed worker, uint256 amount);

    constructor() EIP712("BATON Job Escrow", "1") {}

    function fundJob(
        bytes32 jobId,
        bytes32 termsHash,
        bytes32 taskId,
        address rewardToken,
        address authority,
        address verifier,
        uint64 cutoff,
        uint256[] calldata rewards,
        bytes32[] calldata acceptanceSpecHashes
    ) external {
        if (jobs[jobId].buyer != address(0) || rewards.length == 0 || rewards.length != acceptanceSpecHashes.length) revert InvalidTerms();
        if (cutoff <= block.timestamp) revert DeadlinePassed();
        uint256 total;
        for (uint256 i; i < rewards.length; ++i) {
            if (rewards[i] == 0) revert InvalidTerms();
            total += rewards[i];
            milestones[jobId].push(Milestone(rewards[i], acceptanceSpecHashes[i]));
        }
        IERC20 token = IERC20(rewardToken);
        if (!token.transferFrom(msg.sender, address(this), total)) revert TransferFailed();
        jobs[jobId] = Job({
            buyer: msg.sender,
            rewardToken: token,
            authority: IJobAuthority(authority),
            verifier: verifier,
            termsHash: termsHash,
            taskId: taskId,
            rewardPool: total,
            cutoff: cutoff,
            epoch: 0,
            nextMilestone: 0,
            assignedWorker: address(0),
            acceptedHead: EMPTY_HEAD,
            unallocated: total,
            paused: false,
            drained: false,
            closed: false,
            totalCredited: 0,
            totalWithdrawn: 0,
            totalRefunded: 0
        });
        emit JobFunded(jobId, msg.sender, total);
    }

    function assignTask(bytes32 jobId, address worker) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer || job.assignedWorker != address(0) || job.closed) revert Unauthorized();
        if (block.timestamp >= job.cutoff) revert DeadlinePassed();
        if (!_granted(job, jobId, worker)) revert InvalidWorkerGrant();
        job.assignedWorker = worker;
        job.epoch = 1;
        emit TaskAssigned(jobId, worker, job.epoch);
    }

    function acceptMilestone(bytes32 jobId, MilestoneOffer calldata offer, bytes calldata signature) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer || job.paused || job.drained || job.closed) revert NotOpen();
        if (block.timestamp >= job.cutoff) revert DeadlinePassed();
        if (offer.jobId != jobId || offer.taskId != job.taskId || offer.termsHash != job.termsHash) revert InvalidTerms();
        if (offer.producer != job.assignedWorker || offer.epoch != job.epoch) revert StaleEpoch();
        if (offer.expectedHead != job.acceptedHead || offer.milestone != job.nextMilestone) revert StaleHead();
        if (offer.sequence != acceptedSequences[jobId] + 1 || offer.newHead == EMPTY_HEAD || bytes(offer.manifestRef).length == 0) revert InvalidMilestone();
        if (offer.expiry <= block.timestamp) revert SignatureExpired();
        if (usedNonces[jobId][offer.nonce]) revert Replay();
        if (!_granted(job, jobId, offer.producer)) revert InvalidWorkerGrant();
        if (_hashOffer(offer).recover(signature) != offer.producer) revert InvalidSignature();
        Milestone memory milestone = milestones[jobId][offer.milestone];
        if (milestone.reward == 0 || milestone.acceptanceSpecHash != offer.acceptanceSpecHash) revert InvalidMilestone();
        usedNonces[jobId][offer.nonce] = true;
        job.acceptedHead = offer.newHead;
        acceptedSequences[jobId] = offer.sequence;
        acceptedManifestRefs[jobId] = offer.manifestRef;
        job.nextMilestone += 1;
        job.unallocated -= milestone.reward;
        credits[jobId][offer.producer] += milestone.reward;
        job.totalCredited += milestone.reward;
        emit MilestoneAccepted(jobId, offer.milestone, offer.producer, offer.newHead, offer.sequence, offer.manifestRef, milestone.reward);
    }

    function drainTask(bytes32 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer || job.closed) revert Unauthorized();
        job.drained = true;
    }

    function cancelDrain(bytes32 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer) revert Unauthorized();
        if (job.closed || job.paused || job.nextMilestone >= milestones[jobId].length || block.timestamp >= job.cutoff) {
            revert NotOpen();
        }
        if (!job.drained) revert NotDrained();
        job.drained = false;
        emit TaskDrainCancelled(jobId);
    }

    function takeover(bytes32 jobId, TakeoverAck calldata ack, bytes calldata signature) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer || job.closed || !job.drained) revert NotDrained();
        if (job.paused || job.nextMilestone >= milestones[jobId].length || block.timestamp >= job.cutoff) revert NotOpen();
        if (ack.jobId != jobId || ack.taskId != job.taskId || ack.termsHash != job.termsHash) revert InvalidTerms();
        if (ack.epoch != job.epoch || ack.expectedHead != job.acceptedHead) revert StaleHead();
        if (ack.successor == job.assignedWorker) revert InvalidTerms();
        if (ack.expiry <= block.timestamp) revert SignatureExpired();
        if (usedNonces[jobId][ack.nonce]) revert Replay();
        if (!_granted(job, jobId, ack.successor)) revert InvalidWorkerGrant();
        if (ack.compatibilityReport == EMPTY_HEAD || _hashTakeover(ack).recover(signature) != ack.successor) revert InvalidSignature();
        usedNonces[jobId][ack.nonce] = true;
        address previous = job.assignedWorker;
        job.assignedWorker = ack.successor;
        job.epoch += 1;
        job.drained = false;
        emit TaskTakenOver(jobId, previous, ack.successor, job.epoch);
    }

    function pause(bytes32 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer || job.closed) revert Unauthorized();
        job.paused = true;
        emit JobPaused(jobId);
    }

    function resume(bytes32 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.buyer || job.closed || block.timestamp >= job.cutoff) revert Unauthorized();
        job.paused = false;
        emit JobResumed(jobId);
    }

    function close(bytes32 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.closed || (block.timestamp < job.cutoff && job.nextMilestone < milestones[jobId].length)) revert Unauthorized();
        job.closed = true;
        uint256 refund = job.unallocated;
        job.unallocated = 0;
        job.totalRefunded += refund;
        if (refund > 0 && !job.rewardToken.transfer(job.buyer, refund)) revert TransferFailed();
        emit JobClosed(jobId, refund);
    }

    function claim(bytes32 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        uint256 amount = credits[jobId][msg.sender] - withdrawnCredits[jobId][msg.sender];
        if (amount == 0) revert NothingToClaim();
        withdrawnCredits[jobId][msg.sender] += amount;
        job.totalWithdrawn += amount;
        if (!job.rewardToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit RewardClaimed(jobId, msg.sender, amount);
    }

    function accounting(bytes32 jobId) external view returns (
        uint256 funded,
        uint256 unallocated,
        uint256 workerCreditsOutstanding,
        uint256 totalRefunded,
        uint256 totalWithdrawn
    ) {
        Job storage job = _job(jobId);
        funded = job.rewardPool;
        unallocated = job.unallocated;
        workerCreditsOutstanding = job.totalCredited - job.totalWithdrawn;
        totalRefunded = job.totalRefunded;
        totalWithdrawn = job.totalWithdrawn;
    }

    function acceptedCheckpoint(bytes32 jobId) external view returns (bytes32 head, uint64 sequence, string memory manifestRef) {
        Job storage job = _job(jobId);
        return (job.acceptedHead, acceptedSequences[jobId], acceptedManifestRefs[jobId]);
    }

    function milestoneCount(bytes32 jobId) external view returns (uint256) { return milestones[jobId].length; }

    function _job(bytes32 jobId) private view returns (Job storage job) {
        job = jobs[jobId];
        if (job.buyer == address(0)) revert InvalidTerms();
    }

    function _granted(Job storage job, bytes32 jobId, address worker) private view returns (bool) {
        try job.authority.hasWorkerGrant(jobId, worker) returns (bool allowed) { return allowed; }
        catch { return false; }
    }

    function _hashOffer(MilestoneOffer calldata offer) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            OFFER_TYPEHASH, offer.jobId, offer.taskId, offer.termsHash, offer.producer, offer.epoch,
            offer.milestone, offer.acceptanceSpecHash, offer.expectedHead, offer.newHead,
            keccak256(bytes(offer.manifestRef)), offer.sequence, offer.nonce, offer.expiry
        )));
    }

    function _hashTakeover(TakeoverAck calldata ack) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            TAKEOVER_TYPEHASH, ack.jobId, ack.taskId, ack.termsHash, ack.successor, ack.epoch,
            ack.expectedHead, ack.compatibilityReport, ack.servicePolicy, ack.nonce, ack.expiry
        )));
    }
}
