const SwitchboardSignals = {
    STOP_ASPECTS: new Set(['S1', 'S1r', 'S1c']),
    CLEAR_ASPECTS: new Set(['S2', 'S4', 'S6']),
    CAUTION_ASPECTS: new Set(['S6', 'S7']),

    initialized: false,
    _updateIntervalId: null,

    init() {
        if (this.initialized) return;
        if (!SwitchboardMapper.switchboardGraph || !SwitchboardMapper.ingameGraph || !SwitchboardMapper.mapping) {
            console.warn('SwitchboardSignals.init: mapping not ready');
            return;
        }
        if (typeof signalMarkers === 'undefined' || signalMarkers.size === 0) {
            console.warn('SwitchboardSignals.init: no signal markers available');
            return;
        }

        this.initAllSwitches();
        this.updateAllVirtualSignals();
        this.initialized = true;
    },

    initAllSwitches() {
        for (const [sbId, graphEntry] of SwitchboardMapper.switchboardGraph) {
            this.createSwitchSignals(sbId, graphEntry);
        }
        for (const [sbId, graphEntry] of SwitchboardMapper.switchboardGraph) {
            this.forwardMissingSignals(sbId, graphEntry);
        }
    },

    createSwitchSignals(sbId, graphEntry) {
        graphEntry.signals = {
            Out: null,
            LeftIn: null,
            RightIn: null,
            In: null,
            LeftOut: null,
            RightOut: null
        };
        graphEntry.rawSignals = {
            Out: null,
            LeftIn: null,
            RightIn: null
        };

        const jIdx = SwitchboardMapper.getIngameJunctionIndex(sbId);
        if (jIdx === null) return;
        const ingameData = SwitchboardMapper.ingameGraph.get(jIdx);
        if (!ingameData || !ingameData.junctionId) return;

        const junctionSignals = getSignalsByJunctionId(ingameData.junctionId);
        for (const sig of junctionSignals) {
            const id = sig.Id || '';
            const colonIdx = id.lastIndexOf(':');
            const suffix = colonIdx > 0 ? id.substring(colonIdx + 1) : '';

            // The new Signals fork reports direction from the controller's placement
            // info and the In branch (0=left, 1=right) from the junction group's
            // branch-signal ordering. Old-fork names ({junctionId}:F/:B1/:B2) remain
            // as a fallback for the -mp backend.
            const direction = sig.direction || null;
            const branch = (sig.RequiredBranch !== null && sig.RequiredBranch !== undefined) ? sig.RequiredBranch : null;

            if (direction === 'Out' || suffix === 'F' || suffix === 'T' || (colonIdx <= 0 && sig.direction === 'Out')) {
                graphEntry.signals.Out = sig;
                graphEntry.rawSignals.Out = sig;
            } else if ((direction === 'In' && branch === 0) || suffix === 'B1') {
                graphEntry.signals.LeftIn = sig;
                graphEntry.rawSignals.LeftIn = sig;
            } else if ((direction === 'In' && branch === 1) || suffix === 'B2') {
                graphEntry.signals.RightIn = sig;
                graphEntry.rawSignals.RightIn = sig;
            }
        }

        graphEntry.signals.In = new VirtualSignal(sbId, 'In');
        graphEntry.signals.LeftOut = new VirtualSignal(sbId, 'LeftOut');
        graphEntry.signals.RightOut = new VirtualSignal(sbId, 'RightOut');
    },

    forwardMissingSignals(sbId, graphEntry) {
        if (!graphEntry.signals) return;

        if (!graphEntry.rawSignals.Out) {
            graphEntry.signals.Out = this.forward(sbId, 'common');
        }
        if (!graphEntry.rawSignals.LeftIn) {
            graphEntry.signals.LeftIn = this.forward(sbId, 'left');
        }
        if (!graphEntry.rawSignals.RightIn) {
            graphEntry.signals.RightIn = this.forward(sbId, 'right');
        }
    },

    forward(callerSwitchId, missingPort) {
        const graphEntry = SwitchboardMapper.switchboardGraph.get(callerSwitchId);
        if (!graphEntry) return null;

        const neighbor = graphEntry.neighbors.find(n => n.port === missingPort);
        if (!neighbor) return null;

        const neighborEntry = SwitchboardMapper.switchboardGraph.get(neighbor.switchId);
        if (!neighborEntry) return null;

        const neighborNeighbors = neighborEntry.neighbors.filter(n => n.switchId === callerSwitchId);

        for (const nn of neighborNeighbors) {
            if (nn.port === 'common') {
                return neighborEntry.signals.In;
            }
        }

        if (neighborNeighbors.length > 0) {
            const port = neighborNeighbors[0].port;
            if (port === 'left') {
                return neighborEntry.signals.LeftOut;
            }
            if (port === 'right') {
                return neighborEntry.signals.RightOut;
            }
        }

        return null;
    },

    updateAllVirtualSignals() {
        if (!this.initialized) return;
        let updated = 0;
        for (const [sbId, graphEntry] of SwitchboardMapper.switchboardGraph) {
            if (graphEntry.signals) {
                if (graphEntry.signals.In) { graphEntry.signals.In.update_aspect(); updated++; }
                if (graphEntry.signals.LeftOut) graphEntry.signals.LeftOut.update_aspect();
                if (graphEntry.signals.RightOut) graphEntry.signals.RightOut.update_aspect();
            }
        }

        if (typeof computeAllBlockOccupancyFromVirtualSignals === 'function') {
            const _t0 = performance.now();
            computeAllBlockOccupancyFromVirtualSignals();
            const _elapsed = performance.now() - _t0;
            if (_elapsed > 100) console.warn(`[PERF] computeAllBlockOccupancyFromVirtualSignals took ${_elapsed.toFixed(0)}ms`);
        }
    },

    getSwitchAspectForBlock(sbId) {
        const graphEntry = SwitchboardMapper.switchboardGraph.get(sbId);
        if (!graphEntry || !graphEntry.signals) return null;

        const inAspect = graphEntry.signals.In?.aspect;
        const outAspect = graphEntry.signals.Out?.aspect;

        const aspects = [inAspect, outAspect].filter(a => a !== null && a !== undefined);

        if (aspects.length === 0) return null;

        const hasStop = aspects.some(a => this.STOP_ASPECTS.has(a));
        const hasClear = aspects.some(a => this.CLEAR_ASPECTS.has(a));

        if (hasClear) return 'clear';
        if (hasStop) return 'occupied';
        return null;
    }
};

class VirtualSignal {
    constructor(switchId, direction) {
        this.switchId = switchId;
        this.direction = direction;
        this.aspect = null;
    }

    update_aspect() {
        const graphEntry = SwitchboardMapper.switchboardGraph.get(this.switchId);
        if (!graphEntry || !graphEntry.signals) return;

        if (this.direction === 'LeftOut' || this.direction === 'RightOut') {
            const outSignal = graphEntry.signals.Out;
            const outAspect = outSignal?.aspect ?? null;

            const ingameData = SwitchboardMapper.ingameGraph?.get(
                SwitchboardMapper.getIngameJunctionIndex(this.switchId)
            );
            const currentBranch = ingameData?.currentBranch;

            const alignedLeft = currentBranch === 0;
            const alignedRight = currentBranch === 1;

            if (this.direction === 'LeftOut') {
                this.aspect = alignedLeft ? outAspect : null;
            } else {
                this.aspect = alignedRight ? outAspect : null;
            }
        } else if (this.direction === 'In') {
            const leftAspect = graphEntry.signals.LeftIn?.aspect ?? null;
            const rightAspect = graphEntry.signals.RightIn?.aspect ?? null;

            const stopSet = SwitchboardSignals.STOP_ASPECTS;
            const clearSet = SwitchboardSignals.CLEAR_ASPECTS;

            const leftStop = leftAspect !== null && stopSet.has(leftAspect);
            const rightStop = rightAspect !== null && stopSet.has(rightAspect);
            const leftClear = leftAspect !== null && clearSet.has(leftAspect);
            const rightClear = rightAspect !== null && clearSet.has(rightAspect);

            if (leftStop && rightStop) {
                this.aspect = 'S1';
            } else if (leftClear || rightClear) {
                this.aspect = 'S2';
            } else if (rightAspect === null) {
                this.aspect = leftAspect;
            } else if (leftAspect === null) {
                this.aspect = rightAspect;
            } else {
                this.aspect = leftAspect;
            }
        }
    }
}
