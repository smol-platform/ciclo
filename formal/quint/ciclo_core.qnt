module ciclo_core {
  // Finite model of Ciclo's shared coordination rules.
  //
  // This is not an implementation. It verifies the safety invariants that the
  // implementation must preserve when Beads, MCP auth, and remote sessions
  // interact.

  type Issue = str
  type Principal = str
  type Role = str
  type WorkStatus = str
  type RemoteStatus = str
  type CommandClass = str
  type AuthMode = str

  pure val none: Principal = "none"
  pure val owner: Principal = "owner"
  pure val maintainer: Principal = "maintainer"
  pure val contributor: Principal = "contributor"
  pure val agent: Principal = "agent"
  pure val intruder: Principal = "intruder"

  pure val issueA: Issue = "issueA"
  pure val issueB: Issue = "issueB"
  pure val remoteA: str = "remoteA"
  pure val deploy: CommandClass = "deploy"
  pure val test: CommandClass = "test"

  pure val single: AuthMode = "single"
  pure val multiuser: AuthMode = "multiuser"

  pure val open: WorkStatus = "open"
  pure val claimed: WorkStatus = "claimed"
  pure val blocked: WorkStatus = "blocked"
  pure val closed: WorkStatus = "closed"

  pure val connected: RemoteStatus = "connected"
  pure val stale: RemoteStatus = "stale"
  pure val lost: RemoteStatus = "lost"

  pure val Issues: Set[Issue] = Set(issueA, issueB)
  pure val Principals: Set[Principal] = Set(owner, maintainer, contributor, agent, intruder)
  pure val Remotes: Set[str] = Set(remoteA)
  pure val Commands: Set[CommandClass] = Set(deploy, test)

  var mode: AuthMode
  var remoteDbHealthy: bool
  var remoteDbRequired: bool
  var workStatus: Issue -> WorkStatus
  var claimOwner: Issue -> Principal
  var authenticated: Principal -> bool
  var workClaimGrant: Principal -> bool
  var workUpdateGrant: Principal -> bool
  var commandApproveGrant: Principal -> bool
  var remoteRegisterGrant: Principal -> bool
  var remoteStatus: str -> RemoteStatus
  var remoteWork: str -> Issue
  var remoteRegisteredBy: str -> Principal
  var commandApproved: CommandClass -> Principal
  var contextHasTranscript: Issue -> bool
  var contextHasSensitive: Issue -> bool
  var workMemoryPersisted: Issue -> bool
  var workMemoryRedacted: Issue -> bool
  var transcriptDropped: Issue -> bool
  var tokenLeaked: bool
  var lastDenied: bool

  action init = all {
    mode' = multiuser,
    remoteDbHealthy' = true,
    remoteDbRequired' = true,
    workStatus' = Issues.mapBy(_ => open),
    claimOwner' = Issues.mapBy(_ => none),
    authenticated' = Principals.mapBy(p => p != intruder),
    workClaimGrant' = Principals.mapBy(p => p == owner or p == maintainer or p == contributor or p == agent),
    workUpdateGrant' = Principals.mapBy(p => p == owner or p == maintainer or p == contributor or p == agent),
    commandApproveGrant' = Principals.mapBy(p => p == owner or p == maintainer),
    remoteRegisterGrant' = Principals.mapBy(p => p == owner or p == maintainer),
    remoteStatus' = Remotes.mapBy(_ => connected),
    remoteWork' = Remotes.mapBy(_ => issueA),
    remoteRegisteredBy' = Remotes.mapBy(_ => none),
    commandApproved' = Commands.mapBy(_ => none),
    contextHasTranscript' = Issues.mapBy(_ => true),
    contextHasSensitive' = Issues.mapBy(i => i == issueA),
    workMemoryPersisted' = Issues.mapBy(_ => false),
    workMemoryRedacted' = Issues.mapBy(_ => false),
    transcriptDropped' = Issues.mapBy(_ => false),
    tokenLeaked' = false,
    lastDenied' = false,
  }

  def isAuthed(p: Principal): bool =
    mode == single or authenticated.get(p)

  def canClaim(p: Principal): bool =
    isAuthed(p) and workClaimGrant.get(p)

  def canUpdate(p: Principal): bool =
    isAuthed(p) and workUpdateGrant.get(p)

  def canApproveCommand(p: Principal): bool =
    isAuthed(p) and commandApproveGrant.get(p)

  def canRegisterRemote(p: Principal): bool =
    isAuthed(p) and remoteRegisterGrant.get(p)

  def canCompactContext(p: Principal, i: Issue): bool =
    isAuthed(p)
      and workUpdateGrant.get(p)
      and (claimOwner.get(i) == p or p == owner or p == maintainer or workStatus.get(i) == closed)

  def remoteCoordinationOk(): bool =
    not(remoteDbRequired) or remoteDbHealthy

  action deny = all {
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = true,
  }

  action claimWork(p: Principal, i: Issue): bool = all {
    remoteCoordinationOk,
    canClaim(p),
    workStatus.get(i) == open,
    claimOwner.get(i) == none,
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus.set(i, claimed),
    claimOwner' = claimOwner.set(i, p),
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action updateWork(p: Principal, i: Issue): bool = all {
    canUpdate(p),
    workStatus.get(i) == claimed,
    claimOwner.get(i) == p or p == owner or p == maintainer,
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action closeWork(p: Principal, i: Issue): bool = all {
    canUpdate(p),
    workStatus.get(i) == claimed,
    claimOwner.get(i) == p or p == owner or p == maintainer,
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus.set(i, closed),
    claimOwner' = claimOwner.set(i, none),
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action approveCommand(p: Principal, c: CommandClass): bool = all {
    canApproveCommand(p),
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved.set(c, p),
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action registerRemote(p: Principal, r: str): bool = all {
    canRegisterRemote(p),
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus.set(r, connected),
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy.set(r, p),
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action loseRemote(r: str): bool = all {
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus.set(r, lost),
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action setRemoteDbHealth(ok: bool): bool = all {
    mode' = mode,
    remoteDbHealthy' = ok,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action setMode(nextMode: AuthMode): bool = all {
    mode' = nextMode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action compactContext(p: Principal, i: Issue): bool = all {
    canCompactContext(p, i),
    workStatus.get(i) != open,
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript,
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted.set(i, true),
    workMemoryRedacted' = workMemoryRedacted.set(i, true),
    transcriptDropped' = transcriptDropped,
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action dropTranscriptContext(p: Principal, i: Issue): bool = all {
    canCompactContext(p, i),
    contextHasTranscript.get(i),
    workMemoryPersisted.get(i),
    not(contextHasSensitive.get(i)) or workMemoryRedacted.get(i),
    mode' = mode,
    remoteDbHealthy' = remoteDbHealthy,
    remoteDbRequired' = remoteDbRequired,
    workStatus' = workStatus,
    claimOwner' = claimOwner,
    authenticated' = authenticated,
    workClaimGrant' = workClaimGrant,
    workUpdateGrant' = workUpdateGrant,
    commandApproveGrant' = commandApproveGrant,
    remoteRegisterGrant' = remoteRegisterGrant,
    remoteStatus' = remoteStatus,
    remoteWork' = remoteWork,
    remoteRegisteredBy' = remoteRegisteredBy,
    commandApproved' = commandApproved,
    contextHasTranscript' = contextHasTranscript.set(i, false),
    contextHasSensitive' = contextHasSensitive,
    workMemoryPersisted' = workMemoryPersisted,
    workMemoryRedacted' = workMemoryRedacted,
    transcriptDropped' = transcriptDropped.set(i, true),
    tokenLeaked' = tokenLeaked,
    lastDenied' = false,
  }

  action step = any {
    nondet p = oneOf(Principals)
    nondet i = oneOf(Issues)
    claimWork(p, i),

    nondet p = oneOf(Principals)
    nondet i = oneOf(Issues)
    updateWork(p, i),

    nondet p = oneOf(Principals)
    nondet i = oneOf(Issues)
    closeWork(p, i),

    nondet p = oneOf(Principals)
    nondet c = oneOf(Commands)
    approveCommand(p, c),

    nondet p = oneOf(Principals)
    nondet r = oneOf(Remotes)
    registerRemote(p, r),

    nondet r = oneOf(Remotes)
    loseRemote(r),

    nondet p = oneOf(Principals)
    nondet i = oneOf(Issues)
    compactContext(p, i),

    nondet p = oneOf(Principals)
    nondet i = oneOf(Issues)
    dropTranscriptContext(p, i),

    setRemoteDbHealth(true),
    setRemoteDbHealth(false),
    setMode(single),
    setMode(multiuser),
    deny,
  }

  // Invariants mapped to SPEC-CICLO-001 data-structure rules.

  val invClaimOwnerMatchesStatus =
    Issues.forall(i =>
      (workStatus.get(i) == claimed) == (claimOwner.get(i) != none))

  val invClosedWorkUnclaimed =
    Issues.forall(i =>
      workStatus.get(i) == closed implies claimOwner.get(i) == none)

  val invNoIntruderOwnsWork =
    Issues.forall(i => claimOwner.get(i) != intruder)

  val invNoUnderScopedCommandApproval =
    Commands.forall(c =>
      commandApproved.get(c) == none or commandApproveGrant.get(commandApproved.get(c)))

  val invNoUnderScopedRemoteRegistration =
    Remotes.forall(r =>
      remoteRegisteredBy.get(r) == none or remoteRegisterGrant.get(remoteRegisteredBy.get(r)))

  val invRemoteLostDoesNotReleaseClaimedWork =
    Remotes.forall(r =>
      remoteStatus.get(r) == lost and claimOwner.get(remoteWork.get(r)) != none
        implies workStatus.get(remoteWork.get(r)) == claimed)

  val invTokenNeverLeaked =
    not(tokenLeaked)

  val invTranscriptDroppedOnlyAfterMemoryPersisted =
    Issues.forall(i =>
      transcriptDropped.get(i) implies workMemoryPersisted.get(i))

  val invSensitiveContextMemoryPersistedRedacted =
    Issues.forall(i =>
      workMemoryPersisted.get(i) and contextHasSensitive.get(i) implies workMemoryRedacted.get(i))

  val invDroppedSensitiveTranscriptHadRedactedMemory =
    Issues.forall(i =>
      transcriptDropped.get(i) and contextHasSensitive.get(i) implies workMemoryRedacted.get(i))

  // Regression tests for exact scenarios that matter to Ciclo.
  run unauthorizedClaimDenied = init.then(claimWork(intruder, issueA)).expect(not(workStatus.get(issueA) == claimed))
  run singleModeOwnerCanClaim = init.then(setMode(single)).then(claimWork(owner, issueA)).expect(workStatus.get(issueA) == claimed)
  run remoteDbDownBlocksClaim = init.then(setRemoteDbHealth(false)).then(claimWork(owner, issueA)).expect(not(workStatus.get(issueA) == claimed))
  run maintainerCanApproveDeploy = init.then(approveCommand(maintainer, deploy)).expect(commandApproved.get(deploy) == maintainer)
  run contributorCannotApproveDeploy = init.then(approveCommand(contributor, deploy)).expect(commandApproved.get(deploy) != contributor)
  run maintainerCanRegisterRemote = init.then(registerRemote(maintainer, remoteA)).expect(remoteRegisteredBy.get(remoteA) == maintainer)
  run contributorCannotRegisterRemote = init.then(registerRemote(contributor, remoteA)).expect(remoteRegisteredBy.get(remoteA) != contributor)
  run closeThenCompactThenDropTranscript =
    init
      .then(claimWork(owner, issueA))
      .then(closeWork(owner, issueA))
      .then(compactContext(owner, issueA))
      .then(dropTranscriptContext(owner, issueA))
      .expect(workMemoryPersisted.get(issueA) and workMemoryRedacted.get(issueA) and transcriptDropped.get(issueA))
  run cannotDropTranscriptBeforeMemory =
    init
      .then(claimWork(owner, issueA))
      .then(dropTranscriptContext(owner, issueA))
      .expect(not(transcriptDropped.get(issueA)))
}
