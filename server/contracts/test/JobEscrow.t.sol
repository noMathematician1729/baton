// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {JobEscrow} from "../src/JobEscrow.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function warp(uint256 timestamp) external;
}

contract EscrowTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setFailTransfers(bool shouldFail) external {
        failTransfers = shouldFail;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 approved = allowance[sender][msg.sender];
        if (approved < amount || balanceOf[sender] < amount) return false;
        allowance[sender][msg.sender] = approved - amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (failTransfers || balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract EscrowTestAuthority {
    mapping(bytes32 => mapping(address => bool)) private grants;

    function grant(bytes32 jobId, address worker) external {
        grants[jobId][worker] = true;
    }

    function hasWorkerGrant(bytes32 jobId, address worker) external view returns (bool) {
        return grants[jobId][worker];
    }
}

contract JobEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant JOB_ID = keccak256("incremental-claims-job");
    bytes32 private constant TASK_ID = keccak256("incremental-claims-task");
    bytes32 private constant TERMS_HASH = keccak256("immutable-terms");
    bytes32 private constant SPEC_A = keccak256("acceptance-rules-a");
    bytes32 private constant SPEC_B = keccak256("acceptance-rules-b");
    bytes32 private constant OFFER_TYPEHASH = keccak256(
        "MilestoneOffer(bytes32 jobId,bytes32 taskId,bytes32 termsHash,address producer,uint64 epoch,uint32 milestone,bytes32 acceptanceSpecHash,bytes32 expectedHead,bytes32 newHead,string manifestRef,uint64 sequence,uint256 nonce,uint64 expiry)"
    );
    bytes32 private constant TAKEOVER_TYPEHASH = keccak256(
        "TakeoverAck(bytes32 jobId,bytes32 taskId,bytes32 termsHash,address successor,uint64 epoch,bytes32 expectedHead,bytes32 compatibilityReport,bytes32 servicePolicy,uint256 nonce,uint64 expiry)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    uint256 private constant WORKER_A_KEY = 0xA11CE;
    uint256 private constant WORKER_B_KEY = 0xB0B;
    uint64 private constant EPOCH_ONE = 1;
    uint256 private nonce = 1;

    EscrowTestToken private token;
    EscrowTestAuthority private authority;
    JobEscrow private escrow;
    address private workerA;
    address private workerB;

    function setUp() public {
        token = new EscrowTestToken();
        authority = new EscrowTestAuthority();
        escrow = new JobEscrow();
        workerA = vm.addr(WORKER_A_KEY);
        workerB = vm.addr(WORKER_B_KEY);

        token.mint(address(this), 7);
        token.approve(address(escrow), 7);
        uint256[] memory rewards = new uint256[](2);
        rewards[0] = 3;
        rewards[1] = 4;
        bytes32[] memory specs = new bytes32[](2);
        specs[0] = SPEC_A;
        specs[1] = SPEC_B;
        escrow.fundJob(
            JOB_ID,
            TERMS_HASH,
            TASK_ID,
            address(token),
            address(authority),
            address(this),
            uint64(block.timestamp + 1 days),
            rewards,
            specs
        );
        authority.grant(JOB_ID, workerA);
        authority.grant(JOB_ID, workerB);
        escrow.assignTask(JOB_ID, workerA);
    }

    function testClaimThreeThenEarnAndClaimFour() public {
        bytes32 headOne = sha256("fresh encrypted checkpoint envelope one");
        _accept(WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), headOne, "arkiv://checkpoint/one", 1);

        vm.prank(workerA);
        escrow.claim(JOB_ID);
        require(token.balanceOf(workerA) == 3, "first claim must pay three");
        require(escrow.withdrawnCredits(JOB_ID, workerA) == 3, "first withdrawal total must be three");

        bytes32 headTwo = sha256("fresh encrypted checkpoint envelope two");
        _accept(WORKER_A_KEY, workerA, 1, SPEC_B, headOne, headTwo, "arkiv://checkpoint/two", 2);
        vm.prank(workerA);
        escrow.claim(JOB_ID);
        require(token.balanceOf(workerA) == 7, "second claim must pay the newly earned four");
        require(escrow.withdrawnCredits(JOB_ID, workerA) == 7, "lifetime withdrawals must total seven");

        vm.expectRevert(JobEscrow.NothingToClaim.selector);
        vm.prank(workerA);
        escrow.claim(JOB_ID);
        _assertAccounting(7, 0, 0, 0, 7);
    }

    function testClaimsRemainAvailableAfterTakeoverAndClosure() public {
        bytes32 headOne = sha256("worker A accepted encrypted envelope");
        _accept(WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), headOne, "arkiv://checkpoint/a", 1);
        escrow.drainTask(JOB_ID);
        (JobEscrow.TakeoverAck memory ack, bytes memory signature) = _takeoverAck();
        escrow.takeover(JOB_ID, ack, signature);

        bytes32 headTwo = sha256("worker B accepted encrypted envelope");
        _accept(WORKER_B_KEY, workerB, 1, SPEC_B, headOne, headTwo, "arkiv://checkpoint/b", 2);
        escrow.close(JOB_ID);

        vm.prank(workerA);
        escrow.claim(JOB_ID);
        vm.prank(workerB);
        escrow.claim(JOB_ID);
        require(token.balanceOf(workerA) == 3 && token.balanceOf(workerB) == 4, "handoff claims must remain with their earners");
        _assertAccounting(7, 0, 0, 0, 7);
    }

    function testWrongAcceptanceSpecDoesNotAdvanceHeadOrCredit() public {
        bytes32 head = sha256("checkpoint whose digest is not an acceptance rule");
        (JobEscrow.MilestoneOffer memory offer, bytes memory signature) = _offer(
            WORKER_A_KEY, workerA, 0, keccak256("wrong rules"), bytes32(0), head, "arkiv://checkpoint/wrong-spec", 1
        );
        vm.expectRevert(JobEscrow.InvalidMilestone.selector);
        escrow.acceptMilestone(JOB_ID, offer, signature);
        (bytes32 acceptedHead,,) = escrow.acceptedCheckpoint(JOB_ID);
        require(acceptedHead == bytes32(0), "rejected candidate must not become canonical");
        require(escrow.credits(JOB_ID, workerA) == 0, "rejected candidate must not earn credit");
    }

    function testStaleParentAndOutOfOrderMilestoneDoNotAdvanceState() public {
        bytes32 accepted = sha256("canonical parent");
        _accept(WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), accepted, "arkiv://checkpoint/parent", 1);

        (JobEscrow.MilestoneOffer memory staleParent, bytes memory staleSignature) = _offer(
            WORKER_A_KEY, workerA, 1, SPEC_B, bytes32(0), sha256("stale child"), "arkiv://checkpoint/stale", 2
        );
        vm.expectRevert(JobEscrow.StaleHead.selector);
        escrow.acceptMilestone(JOB_ID, staleParent, staleSignature);

        (JobEscrow.MilestoneOffer memory wrongMilestone, bytes memory wrongMilestoneSignature) = _offer(
            WORKER_A_KEY, workerA, 0, SPEC_B, accepted, sha256("out of order"), "arkiv://checkpoint/order", 2
        );
        vm.expectRevert(JobEscrow.StaleHead.selector);
        escrow.acceptMilestone(JOB_ID, wrongMilestone, wrongMilestoneSignature);

        (bytes32 acceptedHead, uint64 sequence,) = escrow.acceptedCheckpoint(JOB_ID);
        require(acceptedHead == accepted && sequence == 1, "rejected offers must preserve the accepted head");
        require(escrow.credits(JOB_ID, workerA) == 3, "rejected offers must not create extra credit");
    }

    function testInvalidSequenceEmptyHeadAndEmptyLocatorAreRejected() public {
        (JobEscrow.MilestoneOffer memory wrongSequence, bytes memory wrongSequenceSignature) = _offer(
            WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), sha256("sequence gap"), "arkiv://checkpoint/gap", 2
        );
        vm.expectRevert(JobEscrow.InvalidMilestone.selector);
        escrow.acceptMilestone(JOB_ID, wrongSequence, wrongSequenceSignature);

        (JobEscrow.MilestoneOffer memory emptyHead, bytes memory emptyHeadSignature) = _offer(
            WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), bytes32(0), "arkiv://checkpoint/empty-head", 1
        );
        vm.expectRevert(JobEscrow.InvalidMilestone.selector);
        escrow.acceptMilestone(JOB_ID, emptyHead, emptyHeadSignature);

        (JobEscrow.MilestoneOffer memory emptyLocator, bytes memory emptyLocatorSignature) = _offer(
            WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), sha256("no locator"), "", 1
        );
        vm.expectRevert(JobEscrow.InvalidMilestone.selector);
        escrow.acceptMilestone(JOB_ID, emptyLocator, emptyLocatorSignature);

        (bytes32 acceptedHead, uint64 sequence,) = escrow.acceptedCheckpoint(JOB_ID);
        require(acceptedHead == bytes32(0) && sequence == 0, "invalid offers must not commit a head");
        require(escrow.credits(JOB_ID, workerA) == 0, "invalid offers must not allocate credit");
    }

    function testOfferExpiringAtCurrentTimestampIsRejected() public {
        (JobEscrow.MilestoneOffer memory offer, bytes memory signature) = _offerAt(
            WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), sha256("expired now"), "arkiv://checkpoint/expired", 1,
            uint64(block.timestamp)
        );
        vm.expectRevert(JobEscrow.SignatureExpired.selector);
        escrow.acceptMilestone(JOB_ID, offer, signature);
    }

    function testTakeoverCannotReassignTheCurrentWorker() public {
        escrow.drainTask(JOB_ID);
        (JobEscrow.TakeoverAck memory sameWorkerAck, bytes memory sameWorkerSignature) = _takeoverAckFor(
            workerA, WORKER_A_KEY, uint64(block.timestamp + 1 hours)
        );
        vm.expectRevert(JobEscrow.InvalidTerms.selector);
        escrow.takeover(JOB_ID, sameWorkerAck, sameWorkerSignature);

        (JobEscrow.TakeoverAck memory validAck, bytes memory validSignature) = _takeoverAck();
        escrow.takeover(JOB_ID, validAck, validSignature);
    }

    function testInitialAssignmentIsBuyerOnlyAndRequiresJobScopedGrant() public {
        bytes32 secondJobId = keccak256("buyer-controlled-initial-assignment");
        token.mint(address(this), 7);
        token.approve(address(escrow), 7);
        uint256[] memory rewards = new uint256[](1);
        rewards[0] = 7;
        bytes32[] memory specs = new bytes32[](1);
        specs[0] = SPEC_A;
        escrow.fundJob(
            secondJobId,
            keccak256("second-job-terms"),
            keccak256("second-job-task"),
            address(token),
            address(authority),
            address(this),
            uint64(block.timestamp + 1 days),
            rewards,
            specs
        );

        vm.expectRevert(JobEscrow.InvalidWorkerGrant.selector);
        escrow.assignTask(secondJobId, workerB);

        authority.grant(secondJobId, workerB);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        vm.prank(workerB);
        escrow.assignTask(secondJobId, workerB);

        escrow.assignTask(secondJobId, workerB);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.assignTask(secondJobId, workerA);
    }

    function testTransferFailureRollsBackWithdrawalAccounting() public {
        bytes32 head = sha256("checkpoint for failed transfer");
        _accept(WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), head, "arkiv://checkpoint/fail", 1);
        token.setFailTransfers(true);
        vm.expectRevert(JobEscrow.TransferFailed.selector);
        vm.prank(workerA);
        escrow.claim(JOB_ID);
        require(escrow.withdrawnCredits(JOB_ID, workerA) == 0, "failed transfer must not consume worker credit");
        _assertAccounting(7, 4, 3, 0, 0);

        token.setFailTransfers(false);
        vm.prank(workerA);
        escrow.claim(JOB_ID);
        require(token.balanceOf(workerA) == 3, "credit must remain claimable after transfer recovers");
    }

    function testPartialRefundAndEarnedCreditConserveFunding() public {
        bytes32 head = sha256("checkpoint before deadline refund");
        _accept(WORKER_A_KEY, workerA, 0, SPEC_A, bytes32(0), head, "arkiv://checkpoint/refund", 1);
        vm.warp(block.timestamp + 2 days);
        escrow.close(JOB_ID);
        _assertAccounting(7, 0, 3, 4, 0);
        vm.prank(workerA);
        escrow.claim(JOB_ID);
        _assertAccounting(7, 0, 0, 4, 3);
        require(token.balanceOf(address(this)) == 4, "unearned milestone amount must return to the buyer");
    }

    function _accept(
        uint256 workerKey,
        address producer,
        uint32 milestone,
        bytes32 spec,
        bytes32 expectedHead,
        bytes32 newHead,
        string memory manifestRef,
        uint64 sequence
    ) private {
        (JobEscrow.MilestoneOffer memory offer, bytes memory signature) = _offer(
            workerKey, producer, milestone, spec, expectedHead, newHead, manifestRef, sequence
        );
        escrow.acceptMilestone(JOB_ID, offer, signature);
        require(bytes(escrow.acceptedManifestRefs(JOB_ID)).length != 0, "exact locator must be stored");
        require(escrow.acceptedSequences(JOB_ID) == sequence, "accepted sequence must advance atomically");
    }

    function _offer(
        uint256 workerKey,
        address producer,
        uint32 milestone,
        bytes32 spec,
        bytes32 expectedHead,
        bytes32 newHead,
        string memory manifestRef,
        uint64 sequence
    ) private returns (JobEscrow.MilestoneOffer memory offer, bytes memory signature) {
        return _offerAt(
            workerKey,
            producer,
            milestone,
            spec,
            expectedHead,
            newHead,
            manifestRef,
            sequence,
            uint64(block.timestamp + 1 hours)
        );
    }

    function _offerAt(
        uint256 workerKey,
        address producer,
        uint32 milestone,
        bytes32 spec,
        bytes32 expectedHead,
        bytes32 newHead,
        string memory manifestRef,
        uint64 sequence,
        uint64 expiry
    ) private returns (JobEscrow.MilestoneOffer memory offer, bytes memory signature) {
        offer = JobEscrow.MilestoneOffer({
            jobId: JOB_ID,
            taskId: TASK_ID,
            termsHash: TERMS_HASH,
            producer: producer,
            epoch: milestone == 0 ? EPOCH_ONE : (producer == workerA ? EPOCH_ONE : 2),
            milestone: milestone,
            acceptanceSpecHash: spec,
            expectedHead: expectedHead,
            newHead: newHead,
            manifestRef: manifestRef,
            sequence: sequence,
            nonce: nonce++,
            expiry: expiry
        });
        bytes32 structHash = keccak256(abi.encode(
            OFFER_TYPEHASH,
            offer.jobId,
            offer.taskId,
            offer.termsHash,
            offer.producer,
            offer.epoch,
            offer.milestone,
            offer.acceptanceSpecHash,
            offer.expectedHead,
            offer.newHead,
            keccak256(bytes(offer.manifestRef)),
            offer.sequence,
            offer.nonce,
            offer.expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(workerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _takeoverAck() private returns (JobEscrow.TakeoverAck memory ack, bytes memory signature) {
        return _takeoverAckFor(workerB, WORKER_B_KEY, uint64(block.timestamp + 1 hours));
    }

    function _takeoverAckFor(address successor, uint256 signerKey, uint64 expiry)
        private returns (JobEscrow.TakeoverAck memory ack, bytes memory signature)
    {
        ack = JobEscrow.TakeoverAck({
            jobId: JOB_ID,
            taskId: TASK_ID,
            termsHash: TERMS_HASH,
            successor: successor,
            epoch: 1,
            expectedHead: _acceptedHead(),
            compatibilityReport: keccak256("worker B compatibility"),
            servicePolicy: keccak256("service policy"),
            nonce: nonce++,
            expiry: expiry
        });
        bytes32 structHash = keccak256(abi.encode(
            TAKEOVER_TYPEHASH,
            ack.jobId,
            ack.taskId,
            ack.termsHash,
            ack.successor,
            ack.epoch,
            ack.expectedHead,
            ack.compatibilityReport,
            ack.servicePolicy,
            ack.nonce,
            ack.expiry
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerKey,
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash))
        );
        signature = abi.encodePacked(r, s, v);
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("BATON Job Escrow"),
            keccak256("1"),
            block.chainid,
            address(escrow)
        ));
    }

    function _acceptedHead() private view returns (bytes32 head) {
        (head,,) = escrow.acceptedCheckpoint(JOB_ID);
    }

    function _assertAccounting(
        uint256 funded,
        uint256 unallocated,
        uint256 outstanding,
        uint256 refunded,
        uint256 withdrawn
    ) private view {
        (uint256 actualFunded, uint256 actualUnallocated, uint256 actualOutstanding, uint256 actualRefunded, uint256 actualWithdrawn) = escrow.accounting(JOB_ID);
        require(actualFunded == funded, "funded accounting mismatch");
        require(actualUnallocated == unallocated, "unallocated accounting mismatch");
        require(actualOutstanding == outstanding, "outstanding credit mismatch");
        require(actualRefunded == refunded, "refund accounting mismatch");
        require(actualWithdrawn == withdrawn, "withdrawal accounting mismatch");
        require(funded == unallocated + outstanding + refunded + withdrawn, "escrow conservation equation failed");
    }
}
