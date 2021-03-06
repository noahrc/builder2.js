
(function(
  // Reliable reference to the global object (i.e. window in browsers).
  global,

  // Dummy constructor that we use as the .constructor property for
  // functions that return Generator objects.
  GeneratorFunction,

  // Undefined value, more compressible than void 0.
  undefined
) {
  var hasOwn = Object.prototype.hasOwnProperty;

  if (global.wrapGenerator) {
    return;
  }

  function wrapGenerator(innerFn, self, tryList) {
    return new Generator(innerFn, self || null, tryList || []);
  }

  global.wrapGenerator = wrapGenerator;
  if (typeof exports !== "undefined") {
    exports.wrapGenerator = wrapGenerator;
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  wrapGenerator.mark = function(genFun) {
    genFun.constructor = GeneratorFunction;
    return genFun;
  };

  // Ensure isGeneratorFunction works when Function#name not supported.
  if (GeneratorFunction.name !== "GeneratorFunction") {
    GeneratorFunction.name = "GeneratorFunction";
  }

  wrapGenerator.isGeneratorFunction = function(genFun) {
    var ctor = genFun && genFun.constructor;
    return ctor ? GeneratorFunction.name === ctor.name : false;
  };

  function Generator(innerFn, self, tryList) {
    var generator = this;
    var context = new Context(tryList);
    var state = GenStateSuspendedStart;

    function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        throw new Error("Generator has already finished");
      }

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          try {
            var info = delegate.generator[method](arg);

            // Delegate generator ran and handled its own exceptions so
            // regardless of what the method was, we continue as if it is
            // "next" with an undefined arg.
            method = "next";
            arg = undefined;

          } catch (uncaught) {
            context.delegate = null;

            // Like returning generator.throw(uncaught), but without the
            // overhead of an extra function call.
            method = "throw";
            arg = uncaught;

            continue;
          }

          if (info.done) {
            context[delegate.resultName] = info.value;
            context.next = delegate.nextLoc;
          } else {
            state = GenStateSuspendedYield;
            return info;
          }

          context.delegate = null;
        }

        if (method === "next") {
          if (state === GenStateSuspendedStart &&
              typeof arg !== "undefined") {
            // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
            throw new TypeError(
              "attempt to send " + JSON.stringify(arg) + " to newborn generator"
            );
          }

          if (state === GenStateSuspendedYield) {
            context.sent = arg;
          } else {
            delete context.sent;
          }

        } else if (method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw arg;
          }

          if (context.dispatchException(arg)) {
            // If the dispatched exception was caught by a catch block,
            // then let that catch block handle the exception normally.
            method = "next";
            arg = undefined;
          }
        }

        state = GenStateExecuting;

        try {
          var value = innerFn.call(self, context);

          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          var info = {
            value: value,
            done: context.done
          };

          if (value === ContinueSentinel) {
            if (context.delegate && method === "next") {
              // Deliberately forget the last sent value so that we don't
              // accidentally pass it on to the delegate.
              arg = undefined;
            }
          } else {
            return info;
          }

        } catch (thrown) {
          state = GenStateCompleted;

          if (method === "next") {
            context.dispatchException(thrown);
          } else {
            arg = thrown;
          }
        }
      }
    }

    generator.next = invoke.bind(generator, "next");
    generator.throw = invoke.bind(generator, "throw");
  }

  Generator.prototype.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(triple) {
    var entry = { tryLoc: triple[0] };

    if (1 in triple) {
      entry.catchLoc = triple[1];
    }

    if (2 in triple) {
      entry.finallyLoc = triple[2];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry, i) {
    var record = entry.completion || {};
    record.type = i === 0 ? "normal" : "return";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryList.forEach(pushTryEntry, this);
    this.reset();
  }

  Context.prototype = {
    constructor: Context,

    reset: function() {
      this.prev = 0;
      this.next = 0;
      this.sent = undefined;
      this.done = false;
      this.delegate = null;

      this.tryEntries.forEach(resetTryEntry);

      // Pre-initialize at least 20 temporary variables to enable hidden
      // class optimizations for simple generators.
      for (var tempIndex = 0, tempName;
           hasOwn.call(this, tempName = "t" + tempIndex) || tempIndex < 20;
           ++tempIndex) {
        this[tempName] = null;
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    keys: function(object) {
      var keys = [];
      for (var key in object) {
        keys.push(key);
      }
      keys.reverse();

      // Rather than returning an object with a next method, we keep
      // things simple and return the next function itself.
      return function next() {
        while (keys.length) {
          var key = keys.pop();
          if (key in object) {
            next.value = key;
            next.done = false;
            return next;
          }
        }

        // To avoid creating an additional object, we just hang the .value
        // and .done properties off the next function object itself. This
        // also ensures that the minifier will not anonymize the function.
        next.done = true;
        return next;
      };
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;
        return !!caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    _findFinallyEntry: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") && (
              entry.finallyLoc === finallyLoc ||
              this.prev < entry.finallyLoc)) {
          return entry;
        }
      }
    },

    abrupt: function(type, arg) {
      var entry = this._findFinallyEntry();
      var record = entry ? entry.completion : {};

      record.type = type;
      record.arg = arg;

      if (entry) {
        this.next = entry.finallyLoc;
      } else {
        this.complete(record);
      }

      return ContinueSentinel;
    },

    complete: function(record) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = record.arg;
        this.next = "end";
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      var entry = this._findFinallyEntry(finallyLoc);
      return this.complete(entry.completion);
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry, i);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(generator, resultName, nextLoc) {
      this.delegate = {
        generator: generator,
        resultName: resultName,
        nextLoc: nextLoc
      };

      return ContinueSentinel;
    }
  };
}).apply(this, Function("return [this, function GeneratorFunction(){}]")());

var debug = require('debug')('component-builder:scripts');
var path = require('path');
var relative = path.relative;
var requires = require('requires');
var fs = require('graceful-fs');
var Lookup = require('./lookup.js');
var Builder = require('./builder');
var utils = require('../utils');
module.exports = Scripts;
Builder.extend(Scripts);

/**
 * require() implementation.
 * Not included by default.
 *
 * @api public
 */

Scripts.require = fs.readFileSync(require.resolve('component-require2'), 'utf8');

/**
 * Return the entry point of a tree.
 * i.e. the canonical name of the first component
 * with a JS entry point, allowing you to
 * `require(<canonical>.canonical)` to initiate all the
 * components.
 *
 * @param {Object} tree
 * @return {Object} tree
 * @api public
 */

Scripts.canonical = function (tree) {
  // main root has it's own scripts,
  // so it's an entry point.
  var scripts = tree.node.scripts;
  if (scripts && scripts.length) return tree;

  var locals = tree.locals;
  var names = Object.keys(locals);
  if (names.length !== 1) {
    throw new Error('failed to resolve the entry point of component "' + tree.name + '". please either have .scripts or a single .locals in your main component.');
  }
  return locals[names[0]];
}

/**
 * UMD-wrap a build based on the entry point
 * `canonical`, a global `alias`, and the `js`.
 *
 * @param {String} canonical
 * @param {String} alias
 * @param {String} js
 * @return {String}
 * @api public
 */

Scripts.umd = function (canonical, alias, js) {
  return '\n;(function(){\n\n'
    + Scripts.require
    + js
    + 'if (typeof exports == "object") {\n'
    + '  module.exports = require("' + canonical + '");\n'
    + '} else if (typeof define == "function" && define.amd) {\n'
    +'  define("' + alias + '", [], function(){ return require("' + canonical + '"); });\n'
    + '} else {\n'
    + '  (this || window)["' + alias + '"] = require("' + canonical + '");\n'
    + '}\n'
    + '})()\n';
}

function Scripts(branches, options) {
  if (!(this instanceof Scripts)) return new Scripts(branches, options);

  options = options || {};
  Builder.call(this, branches, options);

  // source map support isn't really working yet
  this.sourceMap = options.sourceMap;
  // default enable sourceURLs in dev mode
  this.sourceURL = options.sourceURL != null
    ? options.sourceURL
    : this.dev;
  // default enable aliases in dev mode
  this.alias = options.alias != null ? options.alias
    : options.aliases != null ? options.aliases
    : this.dev;
}

/**
 * Go through all the branches, filter out the components,
 * then format it so we can proces them easier.
 *
 * @param {Object} branch
 * @api private
 */

Scripts.prototype.resolve = function (manifest) {
  // no files, we can skip
  if (!manifest.files.length) return;

  this.resolveMain(manifest);

  manifest.files.forEach(function (file) {
    // commonjs registered name
    file.name = manifest.name + (file.path === manifest.main
      ? ''
      : '/' + file.path);
  });

  this.dispatch(manifest);

  if (this.alias) {
    var self = this;
    this.channel.push(function (done) {
      done(null, self.aliasModule(manifest));
    });
  }
}

/**
 * Resolve the `.main` script.
 *
 * @param {Object} manifest
 * @api private
 */

Scripts.prototype.resolveMain = function (manifest) {
  var component = manifest.node;
  if (component.main) manifest.main = utils.stripLeading(component.main);

  var files = manifest.files;
  if (!component.main) {
    // if no manifest.main, guess by checking files for an index.:format
    for (var i = 0; i < files.length; i++) {
      var path = files[i].path;
      if (/^index\.\w+/.test(path)) {
        manifest.main = path;
        break;
      }
    }
  }

  // do some magic - select the first file
  if (!manifest.main) manifest.main = manifest.files[0].path;
}

/**
 * The last middleware of every field.
 * Checks to see if the file is "used",
 * then appends it if it is.
 *
 * @param {Object} field
 * @param {Object} file
 * @return {String}
 * @api private
 */

Scripts.prototype.append = wrapGenerator.mark(function(field, file) {
  var result;

  return wrapGenerator(function($ctx0) {
    while (1) switch ($ctx0.prev = $ctx0.next) {
    case 0:
      return $ctx0.delegateYield(this.transform(field, file), "t0", 1);
    case 1:
      if (!(file.string === true)) {
        $ctx0.next = 5;
        break;
      }

      $ctx0.next = 4;
      return file.read;
    case 4:
      file.string = $ctx0.sent;
    case 5:
      if (!(typeof file.string !== 'string')) {
        $ctx0.next = 7;
        break;
      }

      return $ctx0.abrupt("return", '');
    case 7:
      if (!file.define) {
        $ctx0.next = 11;
        break;
      }

      return $ctx0.abrupt("return", this.define(file) + '\n\n');
    case 11:
      return $ctx0.delegateYield(this.register(file), "t1", 12);
    case 12:
      result = $ctx0.t1;
      return $ctx0.abrupt("return", result + '\n\n');
    case 14:
    case "end":
      return $ctx0.stop();
    }
  }, this);
});

/**
 * Register a file with the require.register(name, new Function()) stuff.
 * This is added to the end of every middleware stack.
 *
 * To do:
 *
 *   - more aliases for dynamic requires. need to make sure only do one module per alias in case of duplicates.
 *   - define them all at once in one giant object? hahaha dm;gzip
 *
 * @param {Object} file
 * @return {String}
 * @api private
 */

Scripts.prototype.register = wrapGenerator.mark(function(file) {
  var js, lookup, result, i, require, quote, resolvedPath, resolvedRequire, name;

  return wrapGenerator(function($ctx1) {
    while (1) switch ($ctx1.prev = $ctx1.next) {
    case 0:
      js = file.string;
      lookup = Lookup(file, this);
      result = requires(js);
      i = 0;
    case 4:
      if (!(i < result.length)) {
        $ctx1.next = 14;
        break;
      }

      require = result[i];
      quote = require.string.match(/"/) ? '"' : "'";
      return $ctx1.delegateYield(lookup.exec(require.path), "t2", 8);
    case 8:
      resolvedPath = $ctx1.t2;
      resolvedRequire = 'require(' + quote + resolvedPath + quote + ')';
      js = js.replace(require.string, resolvedRequire);
    case 11:
      i++;
      $ctx1.next = 4;
      break;
    case 14:
      // rewrite asset paths
      js = assetPaths(js, function (asset) {
        asset = relative(file.manifest.path, path.resolve(path.dirname(file.filename), asset));
        return path.join(utils.rewriteUrl(file.branch), asset);
      });

      name = file.name;

      if (this.sourceMap || this.sourceURL) {
        if (this.sourceMap && file.sourceMap) {
          js += '\n//# sourceMappingURL='
            + 'data:application/json;charset=utf-8;base64,'
            + new Buffer(file.sourceMap).toString('base64');
        } else {
          js += '\n//# sourceURL=' + relative(this.root, file.filename);
        }
        js = JSON.stringify(js);
        js = js.replace(/\\n/g, '\\n\\\n');
        js = 'require.register("'
          + name
          + '", Function("exports, module",\n'
          + js
          + '\n));';
      } else {
        //js = 'require.register("'
          //+ name
          //+ '", function (exports, module) {\n'
          //+ js
          //+ '\n});';
      }

      return $ctx1.abrupt("return", js);
    case 18:
    case "end":
      return $ctx1.stop();
    }
  }, this);
});

/**
 * Define a module without the closure.
 * Specifically for JSON and strings.
 *
 * @param {Object} file
 * @return {String}
 * @api private
 */

Scripts.prototype.define = function (file) {
  return 'require.define("' + file.name + '", ' + file.string + ');';
}

/**
 * Add aliases for modules to be used outside the build.
 * For depedencies, these are:
 *
 *   <user>-<repo>
 *   <user>~<repo>
 *   <repo>
 *
 * And for locals, these are:
 *
 *   <local-name>
 *
 * Note that these are aliased independently,
 * so a component defined later in the build may overwrite
 * components defined earlier. In general,
 * local components will overwrite remote components,
 * but that's why they are namespaced with <user>.
 *
 * This is NOT meant to be used in production.
 * Use a bundling system or create a local that exposes globals via `window`.
 *
 * This is important for tests until we have a built-in testing framework.
 *
 * This also won't work with reaching, i.e.
 *
 *   require('local/file.js');
 *
 * @param {Object} manifest
 * @api private
 */

Scripts.prototype.aliasModule = function (manifest) {
  var branch = manifest.branch;
  var names;

  switch (branch.type) {
    case 'dependency':
      names = [
        branch.name.replace('/', '-'),
        branch.name.replace('/', '~'),
        branch.name.split('/').pop(),
      ];
      break;
    case 'local':
      names = [branch.name];
      break;
  }

  if (!names) return '';

  return names.map(function (name) {
    return 'require.modules[' + JSON.stringify(name) + '] = '
      + 'require.modules[' + JSON.stringify(branch.canonical) + '];\n'
  }).join('') + '\n\n';
}

// private helpers

function assetPaths(source, replacer) {
  return source.replace(/\/\* component:file \*\/\s+['"](\S+)['"]/g, function (match, p1) {
    var replacement = replacer(p1);
    return replacement ? JSON.stringify(replacement) : match;
  });
}
