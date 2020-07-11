var fs = require("fs");
var compiler = require("../main");

var hasOwn = Object.prototype.hasOwnProperty;

// modules

// function require(relativeTo, id) {
//   var dir = path.dirname(relativeTo);
//   var absPath;
//   if(isRelative(id)) {
//     absPath = path.join(dir, id);
//   }
//   else {
//     absPath = node.resolve(id);
//   }

//   VM.loadScript(absPath);
// }

// vm

var IDLE = "idle";
var SUSPENDED = "suspended";
var EXECUTING = "executing";

function Machine() {
  this.debugInfo = null;
  this.stack = null;
  this.error = undefined;
  this.doRestore = false;
  this.evalResult = null;
  this.state = IDLE;
  this.running = false;
  this._events = {};
  this.stepping = false;
  this.prevStates = [];
  this.tryStack = [];
  this.machineBreaks = [];
  this.machineWatches = [];
}

Machine.prototype.loadScript = function (path) {
  var src = fs.readFileSync(process.argv[2], "utf-8");
  var output = compiler(src, { includeDebug: true });
  var debugInfo = new DebugInfo(output.debugInfo);

  this.setDebugInfo(debugInfo);
  this.setCode(path, output.code);
  this.run();
};

Machine.prototype.loadModule = function (path) {
  var src = fs.readFileSync(process.argv[2], "utf-8");
  var output = compiler(src, { includeDebug: true });

  // run...
};

Machine.prototype.loadString = function (str) {
  var output = compiler(str, { includeDebug: true });
  var debugInfo = new DebugInfo(output.debugInfo);

  this.setDebugInfo(debugInfo);
  this.setCode("/eval", output.code);
};

Machine.prototype.execute = function (fn, thisPtr, args) {
  // console.log('Execute(fn, thisPtr, args)', fn, thisPtr, args)
  var prevState = this.state;
  this.state = EXECUTING;
  this.running = true;

  var prevStepping = this.stepping;
  var prevFrame = this.rootFrame;
  this.stepping = false;
  var ret;

  try {
    if (thisPtr || args) {
      ret = fn.apply(thisPtr, args || []);
    } else {
      ret = fn();
    }
  } catch (e) {
    this.stack = e.fnstack;
    this.error = e.error;
  }

  this.stepping = prevStepping;

  // It's a weird case if we run code while we are suspended, but if
  // so we try to run it and kind of ignore whatever happened (no
  // breakpoints, etc), but we do fire an error event if it happened
  if (prevState === "suspended") {
    if (this.error) {
      this.fire("error", this.error);
    }
    this.state = prevState;
  } else {
    this.checkStatus();
  }

  return ret;
};

Machine.prototype.run = function () {
  var path = this.path;
  var code = this.code;

  var module = {
    exports: {},
  };
  var fn = new Function(
    "VM",
    //'require',
    "module",
    "exports",
    "$Frame",
    "$ContinuationExc",
    "console",
    code + "\nreturn $__global;"
  );

  var rootFn = fn(
    this,
    //require.bind(null, path),
    module,
    module.exports,
    Frame,
    ContinuationExc,
    {
      log: function () {
        var args = Array.prototype.slice.call(arguments);
        this.output += args.join(" ") + "\n";
      }.bind(this),
    }
  );

  this.output = "";
  this.execute(rootFn);
  this.globalFn = rootFn;
};

Machine.prototype.abort = function () {
  this.output = "";
  this.globalFn = null;
  this.state = IDLE;
  this.running = false;
  this.path = "";
  this.code = "";
  this.invokingContinuation = null;
  this.capturingContinuation = false;
  this.error = null;
};

Machine.prototype.getNextStepId = function (machineId, stepId, offset) {
  var locs = this.debugInfo.data.stepIds[machineId];
  var idx = locs.indexOf(stepId);
  if (idx + offset < locs.length) {
    return this.debugInfo.data.stepIds[machineId][idx + offset];
  }
  return null;
};

Machine.prototype.continue = function () {
  if (this.state === SUSPENDED) {
    this.fire("resumed");

    var root = this.getRootFrame();
    var top = this.getTopFrame();
    this.running = true;
    this.state = EXECUTING;

    if (this.machineBreaks[top.machineId][top.next]) {
      // We need to get past this instruction that has a breakpoint, so
      // turn off breakpoints and step past it, then turn them back on
      // again and execute normally
      this.stepping = true;
      this.hasBreakpoints = false;
      this.restore(true);
      // TODO: don't force this back on always
      this.hasBreakpoints = true;
      this.stepping = false;
    }

    this.running = true;
    this.state = EXECUTING;
    this.restore();
  }
};

Machine.prototype.step = function () {
  if (!this.stack) return;
  this.fire("resumed");

  var _step = function () {
    this.running = true;
    this.stepping = true;
    this.hasBreakpoints = false;
    this.restore(true);
    this.hasBreakpoints = true;
    this.stepping = false;
  }.bind(this);

  _step();

  var top = this.getTopFrame();
  while (this.state === SUSPENDED && !this.getLocation()) {
    // Keep stepping until we hit something we know where we are
    // located
    _step();
  }

  if (this.state === SUSPENDED) {
    this.running = false;
    this.fire("paused");
  }
};

Machine.prototype.stepOver = function () {
  if (!this.rootFrame) return;
  var top = this.getTopFrame();
  var curloc = this.getLocation();
  var finalLoc = curloc;
  var biggest = 0;
  var locs = this.debugInfo.data[top.machineId].locs;

  // find the "biggest" expression in the function that encloses
  // this one
  Object.keys(locs).forEach(function (k) {
    var loc = locs[k];

    if (
      loc.start.line <= curloc.start.line &&
      loc.end.line >= curloc.end.line &&
      loc.start.column <= curloc.start.column &&
      loc.end.column >= curloc.end.column
    ) {
      var ldiff =
        curloc.start.line - loc.start.line + (loc.end.line - curloc.end.line);
      var cdiff =
        curloc.start.column -
        loc.start.column +
        (loc.end.column - curloc.end.column);
      if (ldiff + cdiff > biggest) {
        finalLoc = loc;
        biggest = ldiff + cdiff;
      }
    }
  });

  if (finalLoc !== curloc) {
    while (this.getLocation() !== finalLoc) {
      this.step();
    }

    this.step();
  } else {
    this.step();
  }
};

Machine.prototype.evaluate = function (expr) {
  if (expr === "$_") {
    return this.evalResult;
  }

  // An expression can be one of these forms:
  //
  // 1. foo = function() { <stmt/expr> ... }
  // 2. function foo() { <stmt/expr> ... }
  // 3. x = <expr>
  // 4. var x = <expr>
  // 5. <stmt/expr>
  //
  // 1-4 can change any data in the current frame, and introduce new
  // variables that are only available for the current session (will
  // disappear after any stepping/resume/etc). Functions in 1 and 2
  // will be compiled, so they can be paused and debugged.
  //
  // 5 can run any arbitrary expression

  if (this.stack) {
    var top = this.getTopFrame();
    expr = compiler(expr, {
      asExpr: true,
      scope: top.scope,
    }).code;

    this.running = true;
    this.doRestore = true;
    this.stepping = false;
    var res = top.evaluate(this, expr);
    this.stepping = true;
    this.doRestore = false;
    this.running = false;
  } else if (this.globalFn) {
    expr = compiler(expr, {
      asExpr: true,
    }).code;

    this.evalArg = expr;
    this.stepping = true;

    this.withTopFrame(
      {
        next: -1,
        state: {},
      },
      function () {
        this.doRestore = true;
        try {
          (0, this).globalFn();
        } catch (e) {
          if (e.error) {
            throw e.error;
          }
        }
        this.doRestore = false;
      }.bind(this)
    );
  } else {
    throw new Error("invalid evaluation state");
  }

  return this.evalResult;
};

Machine.prototype.restore = function (suppressEvents) {
  try {
    this.doRestore = true;
    this.getRootFrame().restore();
    this.error = undefined;
  } catch (e) {
    this.stack = e.fnstack;
    this.error = e.error;
  }
  this.checkStatus(suppressEvents);
};

Machine.prototype.checkStatus = function (suppressEvents) {
  if (this.stack) {
    if (this.capturingContinuation) {
      this.capturingContinuation = false;
      this.onCapture();
      return;
    }

    if (this.invokingContinuation) {
      var fnstack = this.invokingContinuation;
      this.invokingContinuation = null;
      this.onInvoke(fnstack);
      return;
    }

    if (this.error) {
      if (this.dispatchException()) {
        return;
      }

      if (!suppressEvents) {
        //this.fire('error', this.error);
        throw this.error;
      }
    } else if (!suppressEvents) {
      this.fire("paused");
    }

    this.state = SUSPENDED;
  } else {
    if (!suppressEvents) {
      this.fire("finish");
    }
    this.state = IDLE;
  }

  this.running = false;
};

Machine.prototype.toggleBreakpoint = function (line) {
  var debug = this.debugInfo;
  var pos = debug.lineToMachinePos(line);

  if (pos) {
    this.hasBreakpoints = true;
    if (this.machineBreaks[pos.machineId][pos.locId]) {
      this.machineBreaks[pos.machineId][pos.locId] = false;
    } else {
      this.machineBreaks[pos.machineId][pos.locId] = true;
    }
  }
};

Machine.prototype.callCC = function () {
  this.capturingContinuation = true;
  throw new ContinuationExc();
};

Machine.prototype.onCapture = function () {
  var fnstack = this.stack.map(function (x) {
    return x;
  });
  var top = fnstack[0];
  var tmpid = top.tmpid;
  var next = this.getNextStepId(top.machineId, top.next, 2);

  top.next = this.getNextStepId(top.machineId, top.next, 1);

  top.state["$__t" + (top.tmpid - 1)] = function (arg) {
    top.next = next;
    top.state["$__t" + tmpid] = arg;
    if (this.running) {
      this.invokeContinuation(fnstack);
    } else {
      this.onInvoke(fnstack);
    }
  }.bind(this);

  this.restore();
};

Machine.prototype.invokeContinuation = function (fnstack) {
  this.invokingContinuation = fnstack;
  throw new ContinuationExc();
};

Machine.prototype.onInvoke = function (fnstack) {
  this.stack = fnstack.map(function (x) {
    return x;
  });
  this.fire("cont-invoked");

  if (!this.stepping) {
    this.running = true;
    this.state = EXECUTING;
    this.restore();
  }
};

Machine.prototype.handleWatch = function (machineId, locId, res) {
  var id = this.machineWatches[machineId][locId].id;

  this.fire("watched", {
    id: id,
    value: res,
  });
};

Machine.prototype.on = function (event, handler) {
  var arr = this._events[event] || [];
  arr.push(handler);
  this._events[event] = arr;
};

Machine.prototype.off = function (event, handler) {
  var arr = this._events[event] || [];
  if (handler) {
    var i = arr.indexOf(handler);
    if (i !== -1) {
      arr.splice(i, 1);
    }
  } else {
    this._events[event] = [];
  }
};

Machine.prototype.fire = function (event, data) {
  setTimeout(
    function () {
      var arr = this._events[event] || [];
      arr.forEach(function (handler) {
        handler(data);
      });
    }.bind(this),
    0
  );
};

Machine.prototype.getTopFrame = function () {
  return this.stack && this.stack[0];
};

Machine.prototype.getRootFrame = function () {
  return this.stack && this.stack[this.stack.length - 1];
};

Machine.prototype.getFrameOffset = function (i) {
  // TODO: this is really annoying, but it works for now. have to do
  // two passes
  var top = this.rootFrame;
  var count = 0;
  while (top.child) {
    top = top.child;
    count++;
  }

  if (i > count) {
    return null;
  }

  var depth = count - i;
  top = this.rootFrame;
  count = 0;
  while (top.child && count < depth) {
    top = top.child;
    count++;
  }

  return top;
};

Machine.prototype.setDebugInfo = function (info) {
  this.debugInfo = info || new DebugInfo([]);
  var machines = info.data.machines;
  this.machineBreaks = new Array(machines.length);
  this.machineWatches = new Array(machines.length);

  for (var i = 0; i < machines.length; i++) {
    this.machineBreaks[i] = [];
  }
  for (var i = 0; i < machines.length; i++) {
    this.machineWatches[i] = [];
  }
};

Machine.prototype.setCode = function (path, code) {
  this.path = path;
  this.code = code;
};

Machine.prototype.isStepping = function () {
  return this.stepping;
};

Machine.prototype.getOutput = function () {
  return this.output;
};

Machine.prototype.getState = function () {
  return this.state;
};

Machine.prototype.getLocation = function () {
  if (!this.stack || !this.debugInfo) return;

  var top = this.getTopFrame();
  return this.debugInfo.data.machines[top.machineId].locs[top.next];
};

Machine.prototype.disableBreakpoints = function () {
  this.hasBreakpoints = false;
};

Machine.prototype.enableBreakpoints = function () {
  this.hasBreakpoints = true;
};

Machine.prototype.pushState = function () {
  this.prevStates.push([this.stepping, this.hasBreakpoints]);

  this.stepping = false;
  this.hasBreakpoints = false;
};

Machine.prototype.popState = function () {
  var state = this.prevStates.pop();
  this.stepping = state[0];
  this.hasBreakpoints = state[1];
};

Machine.prototype.pushTry = function (
  stack,
  catchLoc,
  finallyLoc,
  finallyTempVar
) {
  if (finallyLoc) {
    stack.push({
      finallyLoc: finallyLoc,
      finallyTempVar: finallyTempVar,
    });
  }

  if (catchLoc) {
    stack.push({
      catchLoc: catchLoc,
    });
  }
};

Machine.prototype.popCatch = function (stack, catchLoc) {
  var entry = stack[stack.length - 1];
  if (entry && entry.catchLoc === catchLoc) {
    stack.pop();
  }
};

Machine.prototype.popFinally = function (stack, finallyLoc) {
  var entry = stack[stack.length - 1];

  if (!entry || !entry.finallyLoc) {
    stack.pop();
    entry = stack[stack.length - 1];
  }

  if (entry && entry.finallyLoc === finallyLoc) {
    stack.pop();
  }
};

Machine.prototype.dispatchException = function () {
  if (this.error == null) {
    return false;
  }

  var exc = this.error;
  var dispatched = false;
  var prevStepping = this.stepping;
  this.stepping = false;

  for (var i = 0; i < this.stack.length; i++) {
    var frame = this.stack[i];

    if (frame.dispatchException(this, exc)) {
      // shave off the frames were walked over
      this.stack = this.stack.slice(i);
      dispatched = true;
      break;
    }
  }

  if (!prevStepping && dispatched) {
    this.restore();
    this.error = undefined;
  }

  return dispatched;
};

Machine.prototype.keys = function (obj) {
  return Object.keys(obj).reverse();
};

Machine.prototype.popFrame = function () {
  var r = this.stack.pop();
  if (!this.stack.length) {
    this.doRestore = false;
    this.stack = null;
  }
  return r;
};

Machine.prototype.nextFrame = function () {
  if (this.stack && this.stack.length) {
    return this.stack[this.stack.length - 1];
  }
  return null;
};

Machine.prototype.withTopFrame = function (frame, fn) {
  var prev = this.stack;
  this.stack = [frame];
  try {
    var newFrame;
    if ((newFrame = fn())) {
      // replace the top of the real stack with the new frame
      prev[0] = newFrame;
    }
  } finally {
    this.stack = prev;
  }
};

// frame

function Frame(
  machineId,
  name,
  fn,
  next,
  state,
  scope,
  thisPtr,
  tryStack,
  tmpid
) {
  this.machineId = machineId;
  this.name = name;
  this.fn = fn;
  this.next = next;
  this.state = state;
  this.scope = scope;
  this.thisPtr = thisPtr;
  this.tryStack = tryStack;
  this.tmpid = tmpid;
}

Frame.prototype.restore = function () {
  this.fn.call(this.thisPtr);
};

Frame.prototype.evaluate = function (machine, expr) {
  machine.evalArg = expr;
  machine.error = undefined;
  machine.stepping = true;

  machine.withTopFrame(
    this,
    function () {
      var prevNext = this.next;
      this.next = -1;

      try {
        this.fn.call(this.thisPtr);
      } catch (e) {
        if (!(e instanceof ContinuationExc)) {
          throw e;
        } else if (e.error) {
          throw e.error;
        }

        var newFrame = e.fnstack[0];
        newFrame.next = prevNext;
        return newFrame;
      }

      throw new Error("eval did not get a frame back");
    }.bind(this)
  );

  return machine.evalResult;
};

Frame.prototype.stackEach = function (func) {
  if (this.child) {
    this.child.stackEach(func);
  }
  func(this);
};

Frame.prototype.stackMap = function (func) {
  var res;
  if (this.child) {
    res = this.child.stackMap(func);
  } else {
    res = [];
  }

  res.push(func(this));
  return res;
};

Frame.prototype.stackReduce = function (func, acc) {
  if (this.child) {
    acc = this.child.stackReduce(func, acc);
  }

  return func(acc, this);
};

Frame.prototype.getLocation = function (machine) {
  return machine.debugInfo.data[this.machineId].locs[this.next];
};

Frame.prototype.dispatchException = function (machine, exc) {
  if (!this.tryStack) {
    return false;
  }

  var next;
  var hasCaught = false;
  var hasFinally = false;
  var finallyEntries = [];

  for (var i = this.tryStack.length - 1; i >= 0; i--) {
    var entry = this.tryStack[i];
    if (entry.catchLoc) {
      next = entry.catchLoc;
      hasCaught = true;
      break;
    } else if (entry.finallyLoc) {
      finallyEntries.push(entry);
      hasFinally = true;
    }
  }

  // initially, `next` is undefined which will jump to the end of the
  // function. (the default case)
  while ((entry = finallyEntries.pop())) {
    this.state["$__t" + entry.finallyTempVar] = next;
    next = entry.finallyLoc;
  }

  this.next = next;

  if (hasFinally && !hasCaught) {
    machine.withTopFrame(
      this,
      function () {
        machine.doRestore = true;
        this.restore();
      }.bind(this)
    );
  }

  return hasCaught;
};

// debug info

function DebugInfo(data) {
  this.data = data;
}

DebugInfo.prototype.lineToMachinePos = function (line) {
  if (!this.data) return null;
  var machines = this.data.machines;

  // Iterate over the machines backwards because they are ordered
  // innermost to top-level, and we want to break on the outermost
  // function.
  for (var i = machines.length - 1; i >= 0; i--) {
    var locs = machines[i].locs;
    var keys = Object.keys(locs);

    for (var cur = 0, len = keys.length; cur < len; cur++) {
      var loc = locs[keys[cur]];
      if (loc.start.line === line) {
        return {
          machineId: i,
          locId: parseInt(keys[cur]),
        };
      }
    }
  }

  return null;
};

DebugInfo.prototype.closestMachinePos = function (start, end) {
  if (!this.data) return null;

  for (var i = 0, l = this.data.length; i < l; i++) {
    var locs = this.data[i].locs;
    var keys = Object.keys(locs);
    keys = keys.map(function (k) {
      return parseInt(k);
    });
    keys.sort(function (a, b) {
      return a - b;
    });

    for (var cur = 0, len = keys.length; cur < len; cur++) {
      var loc = locs[keys[cur]];

      if (
        (loc.start.line < start.line ||
          (loc.start.line === start.line && loc.start.column <= start.ch)) &&
        (loc.end.line > end.line ||
          (loc.end.line === end.line && loc.end.column >= end.ch))
      ) {
        return {
          machineId: i,
          locId: keys[cur],
        };
      }
    }
  }

  return null;
};

DebugInfo.prototype.setWatch = function (pos, src) {
  // TODO: real uuid
  var id = (Math.random() * 10000) | 0;
  this.watches.push({
    pos: pos,
    src: src,
    id: id,
  });

  return id;
};

function ContinuationExc(error, initialFrame, savedFrames) {
  this.fnstack = savedFrames ? savedFrames : initialFrame ? [initialFrame] : [];
  this.error = error;
  this.reuse = !!initialFrame;
}

ContinuationExc.prototype.pushFrame = function (frame) {
  // console.log('pushFrame(frame)', frame)
  this.fnstack.push(frame);
};

// exports

module.exports.$Machine = Machine;
module.exports.$Frame = Frame;
module.exports.$DebugInfo = DebugInfo;
module.exports.$ContinuationExc = ContinuationExc;
