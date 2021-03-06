// Copyright 2012 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

(function(global) {
  "use strict";

  function isIndex(s) {
    return +s === s >>> 0;
  }

  function isNotIndex(s) {
    return !isIndex(s);
  }

  function removeIndices(arr) {
    var indices = Object.keys(arr).filter(isIndex);
    for (var i = 0; i < indices; i++)
      delete arr[indices[i]];
  }

  function toNumber(s) {
    return +s;
  }

  function isObject(obj) {
    return obj === Object(obj);
  }

  // FIXME: Use Map/Set iterators when available.
  var HarmonyMap = global.Map ? global.Map : null;
  var HarmonySet = global.Set ? global.Set : null;

  function Map() {
    if (HarmonyMap)
      this.map_ = new HarmonyMap;
    else
      this.values_ = [];

    this.keys_ = [];
  }

  Map.prototype = {
    get: function(key) {
      return this.map_ ? this.map_.get(key) : this.values_[this.keys_.indexOf(key)];
    },

    set: function(key, value) {
      if (this.map_) {
        if (!this.map_.has(key))
          this.keys_.push(key);
        return this.map_.set(key, value);
      }

      var index = this.keys_.indexOf(key);
      if (index < 0)
        index = this.keys_.length;

      this.keys_[index] = key;
      this.values_[index] = value;
    },

    has: function(key) {
      return this.map_ ? this.map_.has(key) : this.keys_.indexOf(key) >= 0;
    },

    delete: function(key) {
      var index = this.keys_.indexOf(key);
      this.keys_.splice(index, 1);
      if (this.map_)
        this.map_.delete(key);
      else
        this.values_.splice(index, 1);
    },

    keys: function() {
      return this.keys_.slice();
    }
  }

  function Set() {
    if (HarmonySet)
      this.set_ = new HarmonySet;

    this.keys_ = [];
  }

  Set.prototype = {
    add: function(key) {
      if ((this.set_ && this.set_.has(key)) || (!this.set_ && this.keys_.indexOf(key) >= 0))
        return;

      this.keys_.push(key);

      if (this.set_)
        this.set_.add(key);
    },

    has: function(key) {
      return this.set_ ? this.set_.has(key) : this.keys_.indexOf(key) >= 0;
    },

    delete: function(key) {
      var index = this.keys_.indexOf(key);
      this.keys_.splice(index, 1);
      if (this.set_)
        this.set_.delete(key);
    },

    keys: function() {
      return this.keys_.slice();
    }
  }

  var pathIndentPart = '[\$a-z0-9_]+[\$a-z0-9_\\d]*';
  var pathRegExp = new RegExp('^' +
                              '(?:#?' + pathIndentPart + ')?' +
                              '(?:' +
                                '(?:\\.' + pathIndentPart + ')' +
                              ')*' +
                              '$', 'i');

  function isPathValid(s) {
    if (typeof s != 'string')
      return false;
    s = s.replace(/\s/g, '');
    if (s == '')
      return false;

    if (s[0] == '.')
      return false;

    return pathRegExp.test(s);
  }

  function Path(s) {
    if (!isPathValid(s))
      return this;

    if (isIndex(s)) {
      this.push(String(s));
      return this;
    }

    s.split(/\./).filter(function(part) {
      return part;
    }).forEach(function(part) {
      this.push(part);
    }, this);
  }

  Path.prototype = {
    __proto__: [],

    toString: function() {
      return this.join('.');
    },

    walkPropertiesFrom: function(val, f, that) {
      var caughtException;
      var prop;
      for (var i = 0; i < this.length + 1; i++) {
        prop = this[i];
        f.call(that, prop, val, i);

        if (isObject(val) && i < this.length && this[i] in val) {
          try {
            val = val[prop];
          } catch (ex) {
            val = undefined;
            caughtException = ex;
          }
        } else {
          val = undefined;
        }
      }
    }
  };

  /**
   * Callback looks like this
   *
  function callback(summaries) {
    summaries.forEach(function(summary) {
      summary.newProperties; // [ Array of String (propertyName) ]
      summary.deletedProperties; // [ Array of String (propertyName) ]
      summary.arraySplices; // [ Array of
                            //   {
                            //     index: [ Number ]
                            //     removed: [ Number ]
                            //     addedCount: [ Number ]
                            //   }
                            // ]

      summary.pathValueChanged; // [Array of String (path) ]
      summary.getOldPathValue(path) = function() {};
      summary.getNewPathValue(path) = function() {};
    });
  }
  */

  function ChangeSummary(callback) {
    var observing = true;
    var isDisconnecting = false;
    var summaries;

    var objectTrackers = new Map;

    function getObjectTracker(obj) {
      var tracker = objectTrackers.get(obj);
      if (!tracker) {
        tracker = new ObjectTracker(obj);
        tracker.internal = internal;
        objectTrackers.set(obj, tracker);
        Object.observe(obj, internalCallback);
      }

      return tracker;
    }

    function removeObjectTracker(obj) {
      var tracker = objectTrackers.get(obj);
      objectTrackers.delete(obj);
      Object.unobserve(obj, internalCallback);
      tracker.dead = true;
    }

    function internalCallback(records) {
      if (!records || !records.length) {
        console.error('Object.observe callback called with no records');
        return;
      }

      try {
        var activeTrackers = new Set;
        records.forEach(function(record) {
          var tracker = objectTrackers.get(record.object);
          tracker.addChangeRecord(record);
          activeTrackers.add(tracker);
        });

        var dirtyTrackers = new Set;
        activeTrackers.keys().forEach(function(tracker) {
          tracker.process(objectTrackers, dirtyTrackers);
        });

        summaries = [];
        dirtyTrackers.keys().forEach(function(tracker) {
          var summary = tracker.produceSummary();
          if (summary)
            summaries.push(summary);
        });

        if (!summaries.length)
          summaries = undefined;

        if (!isDisconnecting && summaries) {
          callback(summaries);
          summaries = undefined;
        }
      } catch (ex) {
        console.error(ex);
      }
    }

    // Register callback to assign delivery order.
    var register = {};
    Object.observe(register, internalCallback);
    Object.unobserve(register, internalCallback);

    this.observe = function(obj) {
      if (!isObject(obj))
        throw Error('Invalid attempt to observe non-object: ' + obj);

      getObjectTracker(obj).observeAll = true;
    };

    this.unobserve = function(obj) {
      if (!isObject(obj))
        throw Error('Invalid attempt to unobserve non-object: ' + obj);

      var tracker = objectTrackers.get(obj);
      if (!tracker)
        return;

      tracker.observeAll = undefined;
      if (!tracker.observePropertySet && !tracker.propertyObserverCount)
        removeObjectTracker(obj);
    };

    this.observePropertySet = function(obj) {
      if (!isObject(obj))
        throw Error('Invalid attempt to observe non-object: ' + obj);

      getObjectTracker(obj).observePropertySet = true;
    };

    this.unobservePropertySet = function(obj) {
      if (!isObject(obj))
        throw Error('Invalid attempt to unobserve non-object: ' + obj);

      var tracker = objectTrackers.get(obj);
      if (!tracker)
        return;

      tracker.observePropertySet = undefined;
      if (!tracker.observeAll && !tracker.propertyObserverCount)
        removeObjectTracker(obj);
    };

    // FIXME: Notate and check all places where model values are retrieved and script may run.
    // FIXME: Think about how things will react if observe/unobserve are called during processing.

    var internal = {
      observeProperty: function(obj, prop, pathValue) {
        getObjectTracker(obj).observeProperty(prop, pathValue);
      },

      unobserveProperty: function(obj, prop, pathValue) {
        var tracker = objectTrackers.get(obj);
        if (!tracker)
          return;

        tracker.unobserveProperty(prop, pathValue);
        if (!tracker.propertyObserverCount && !tracker.observePropertySet && !tracker.observeAll)
          removeObjectTracker(obj);
      }
    };

    this.observePathValue = function(obj, pathString) {
      if (!isObject(obj))
        throw Error('Invalid attempt to unobserve non-object: ' + obj);

      var path = new Path(pathString);
      if (path.length == 0)
        throw Error('Invalid path: ' + pathString);

      var tracker = getObjectTracker(obj);
      if (!tracker.pathValues)
        tracker.pathValues = {};

      var pathValue = tracker.pathValues[path.toString()];

      if (pathValue) {
        pathValue.reset();
      } else {
        pathValue = new PathValue(internal, obj, path);
        tracker.pathValues[path.toString()] = pathValue;
      }

      return pathValue.value;
    };

    this.unobservePathValue = function(obj, pathString) {
      if (!isObject(obj))
        throw Error('Invalid attempt to unobserve non-object: ' + obj);

      var path = new Path(pathString);
      if (path.length == 0)
        return;

      var tracker = objectTrackers.get(obj);
      if (!tracker || !tracker.pathValues)
        return;

      var pathValue = tracker.pathValues[path.toString()];
      if (!pathValue)
        return;

      tracker.pathValues[path.toString()] = undefined;
      pathValue.clear();
    };

    this.deliver = function() {
      Object.deliverChangeRecords(internalCallback);
    }

    this.disconnect = function() {
      if (!observing)
        return;
      isDisconnecting = true;
      this.deliver();
      isDisconnecting = false;

      objectTrackers.keys().forEach(function(object) {
        Object.unobserve(object, internalCallback);
      });

      observing = false;

      if (!summaries)
        return;
      var retval = summaries;
      summaries = undefined;
      return retval;
    };

    this.reconnect = function() {
      if (observing)
        return;

      objectTrackers.keys().forEach(function(object) {
        Object.observe(object, internalCallback);
      });

      observing = true;
    };
  }

  function ObjectTracker(obj) {
    this.object = obj;
    this.propertyObserverCount = 0;
    this.changeRecords = [];
  }

  ObjectTracker.prototype = {

    observeProperty: function(name, pathValue) {
      if (!this.propertyObservers)
        this.propertyObservers = {};

      var pathValueMap = this.propertyObservers[name];
      if (!pathValueMap) {
        pathValueMap = new Set;
        this.propertyObservers[name] = pathValueMap;
      }

      if (pathValueMap.has(pathValue))
        return;

      pathValueMap.add(pathValue);
      this.propertyObserverCount++;
    },

    unobserveProperty: function(name, pathValue) {
      if (!this.propertyObservers)
        return;

      var pathValueMap = this.propertyObservers[name];
      if (!pathValueMap)
        return;

      if (!pathValueMap.has(pathValue))
        return;

      pathValueMap.delete(pathValue);
      if (pathValueMap.keys().length == 0)
        this.propertyObservers[name] = undefined;
      this.propertyObserverCount--;
    },

    addChangeRecord: function(changeRecord) {
      this.changeRecords.push(changeRecord);
    },

    process: function(objectTrackers, dirtyTrackers) {
      var changeRecords = this.changeRecords;
      this.changeRecords = [];

      if (this.dead)  // observation stopped mid-process.
        return;

      var diff = diffObjectFromChangeRecords(changeRecords);
      var valueChanged = diff.valueChanged;
      var added = diff.added;
      var deleted = diff.deleted;

      if (this.observeAll) {
        var ownPropertiesChanged = {};

        var props = Object.keys(valueChanged);
        if (Array.isArray(this.object))
          props = props.filter(isNotIndex);

        props.forEach(function(prop) {
          ownPropertiesChanged[prop] = valueChanged[prop];
        }, this);

        if (Object.keys(ownPropertiesChanged).length) {
          this.ownPropertiesChanged = ownPropertiesChanged;
          dirtyTrackers.add(this);
        }
      }

      if (this.observePropertySet || this.observeAll) {
        this.added = added;
        this.deleted = deleted;

        if (this.observeAll)
          this.valueChanged = valueChanged;

        if (Array.isArray(this.object)) {
          this.splices = projectArraySplices(this.object, valueChanged);
          this.added = this.added.filter(isNotIndex);
          this.deleted = this.deleted.filter(isNotIndex);
        }

        if (this.added.length || this.deleted.length || (this.splices && this.splices.length))
          dirtyTrackers.add(this);
      }

      if (!this.propertyObservers)
        return;

      var props = Object.keys(valueChanged);

      for (var i = 0; i < props.length; i++) {
        var pathValues = this.propertyObservers[props[i]];
        if (!pathValues)
          continue;

        pathValues.keys().forEach(function(pathValue) {
          var observed = pathValue.observed[0];
          var tracker = objectTrackers.get(observed);
          if (!tracker.dirtyPathValues)
            tracker.dirtyPathValues = new Set;
          tracker.dirtyPathValues.add(pathValue);
          dirtyTrackers.add(tracker)
        });
      }
    },

    produceSummary: function() {
      var anyChanges = false;

      var summary = {
        object: this.object
      }

      if (this.observePropertySet || this.observeAll) {
        summary.newProperties = this.added;
        summary.deletedProperties = this.deleted;

        anyChanges |= summary.newProperties.length || summary.deletedProperties.length;

        this.added = undefined;
        this.deleted = undefined;

        if (this.splices) {
          summary.arraySplices = this.splices;
          anyChanges |= summary.arraySplices.length;
          this.splices = undefined;
        }
      };

      var dirtyPathValues = this.dirtyPathValues ? this.dirtyPathValues.keys() : [];
      dirtyPathValues.sort(pathValueSort);
      this.dirtyPathValues = undefined;

      var oldValues = {};
      var newValues = {};

      dirtyPathValues.forEach(function(pathValue) {
        var oldValue = pathValue.value;
        if (pathValue.reset()) {
          var pathString = pathValue.path.toString();
          oldValues[pathString] = oldValue;
          newValues[pathString] = pathValue.value;

          if (!summary.pathValueChanged)
            summary.pathValueChanged = [];
          summary.pathValueChanged.push(pathString);
          if (this.ownPropertiesChanged && this.ownPropertiesChanged.hasOwnProperty(pathString))
            delete this.ownPropertiesChanged[pathString];
        }
      }, this);

      if (this.observeAll && this.ownPropertiesChanged) {
        var ownPathValueChanged = [];

        Object.keys(this.ownPropertiesChanged).forEach(function(prop) {
          var oldValue = this.ownPropertiesChanged[prop];
          var newValue = this.object[prop];
          if (oldValue !== newValue) {
            ownPathValueChanged.push(prop);
            oldValues[prop] = oldValue;
            newValues[prop] = newValue;
          }
        }, this);

        if (ownPathValueChanged.length) {
          summary.pathValueChanged = summary.pathValueChanged || [];
          summary.pathValueChanged = ownPathValueChanged.sort().concat(summary.pathValueChanged);
        }
      }

      if (summary.pathValueChanged) {
        anyChanges = true;

        // Fixme: what if path strings are different, e.g. [] vs .
        summary.getOldPathValue = function(string) {
          return oldValues[string];
        };

        summary.getNewPathValue = function(string) {
          return newValues[string];
        };
      }

      return anyChanges ? summary : undefined;
    }
  };

  function pathValueSort(a, b) {
    if (a.path.length < b.path.length)
      return -1;
    if (a.path.length > b.path.length)
      return 1;

    var aStr = a.path.toString();
    var bStr = b.path.toString();

    return aStr < bStr ? -1 : (aStr > bStr ? 1 : 0);
  }

  function PathValue(internal, object, path) {
    this.path = path;
    this.observed = new Array(path.length - 1);

    var self = this;

    this.reset = function() {
      var changed = false;
      self.path.walkPropertiesFrom(object, function(prop, value, i) {
        if (i == this.path.length) {
          if (this.value == value)
            return;

          changed = true;
          this.value = value;
          return;
        }

        var observed = this.observed[i];
        if (value === observed)
          return;

        if (observed !== undefined) {
          internal.unobserveProperty(observed, prop, this);
          this.observed[i] = observed = undefined;
        }

        if (!isObject(value))
          return;

        this.observed[i] = observed = value;
        internal.observeProperty(observed, prop, this);
      }, self);

      return changed;
    };

    this.clear = function() {
      object = undefined;
      self.reset();
    };

    this.reset();
  }

  function diffObjectFromChangeRecords(changeRecords) {
    var added = {};
    var deleted = {};
    var valueChanged = {};

    for (var i = 0; i < changeRecords.length; i++) {
      var record = changeRecords[i];
      if (record.type != 'new' &&
          record.type != 'updated' &&
          record.type != 'deleted') {
        console.error('Unknown changeRecord type: ' + record.type);
        console.error(record);
        continue;
      }

      if (!(record.name in valueChanged)) {
        valueChanged[record.name] = record.oldValue;
      }

      if (record.type == 'updated') {
        continue;
      }

      if (record.type == 'new') {
        if (record.name in deleted) {
          delete deleted[record.name];
        } else {
          added[record.name] = true;
        }
        continue;
      }

      // Deleted
      if (record.name in added) {
        delete added[record.name];
        delete valueChanged[record.name];
      } else {
        deleted[record.name] = true;
      }
    }

    return {
      added: Object.keys(added).sort(),
      deleted: Object.keys(deleted).sort(),
      valueChanged: valueChanged
    };
  }

  /**
   * Splice Projection functions:
   *
   * A splice map is a representation of how a previous array of items
   * was transformed into a new array of items. Conceptually it is a list of
   * tuples of
   *
   *   <index, removed, addedCount>
   *
   * which are kept in ascending index order of. The tuple represents that at
   * the |index|, |removed| sequence of items were removed, and counting forward
   * from |index|, |addedCount| items were added.
   */

  /**
   * Lacking individual splice mutation information, the minimal set of
   * splices can be synthesized given the previous state and final state of an
   * array. The basic approach is to calculate the edit distance matrix and
   * choose the shortest path through it.
   *
   * Complexity: O(l * p)
   *   l: The length of the current array
   *   p: The length of the old array
   */
  function calcSplices(current, currentIndex, currentLength, old) {
    var LEAVE = 0;
    var UPDATE = 1;
    var ADD = 2;
    var DELETE = 3;

    function newSplice(index, removed, addedCount) {
      return {
        index: index,
        removed: Array.prototype.slice.apply(removed),
        addedCount: addedCount
      };
    }

    // Note: This function is *based* on the computation of the Levenshtein
    // "edit" distance. The one change is that "updates" are treated as two
    // edits - not one. With Array splices, an update is really a delete
    // followed by an add. By retaining this, we optimize for "keeping" the
    // maximum array items in the original array. For example:
    //
    //   'xxxx123' -> '123yyyy'
    //
    // With 1-edit updates, the shortest path would be just to update all seven
    // characters. With 2-edit updates, we delete 4, leave 3, and add 4. This
    // leaves the substring '123' intact.
    function calcEditDistances(current, currentIndex, currentLength, old) {
      // "Deletion" columns
      var distances = new Array(old.length + 1);

      // "Addition" rows. Initialize null column.
      for (var i = 0; i < distances.length; i++) {
        distances[i] = new Array(currentLength + 1)
        distances[i][0] = i;
      }

      // Initialize null row
      for (var j = 0; j < distances[0].length; j++) {
        distances[0][j] = j;
      }

      for (var i = 1; i < distances.length; i++) {
        for (var j = 1; j < distances[i].length; j++) {
          if (old[i - 1] === current[currentIndex + j - 1])
            distances[i][j] = distances[i - 1][j - 1];
          else
            distances[i][j] = Math.min(distances[i - 1][j] + 1,      // 1 Edit
                                       distances[i][j - 1] + 1,      // 1 Edit
                                       distances[i - 1][j - 1] + 2); // 2 Edits
        }
      }

      return distances;
    }

    // This starts at the final weight, and walks "backward" by finding
    // the minimum previous weight recursively until the origin of the weight
    // matrix.
    function operations(distances) {
      var i = distances.length - 1;
      var j = distances[0].length - 1;
      var last = distances[i][j];
      var edits = [];
      while (i > 0 || j > 0) {
        if (i == 0) {
          edits.push(ADD);
          j--;
          continue;
        }
        if (j == 0) {
          edits.push(DELETE);
          i--;
          continue;
        }
        var updateOrNoop = distances[i - 1][j - 1];
        var deletion = distances[i - 1][j];
        var addition = distances[i][j - 1];

        var min = Math.min(updateOrNoop, deletion, addition);
        if (min == updateOrNoop) {
          if (updateOrNoop == last) {
            edits.push(LEAVE);
          } else {
            edits.push(UPDATE);
            last = updateOrNoop;
          }
          i--;
          j--;
        } else if (min == deletion) {
          edits.push(DELETE);
          i--;
          last = deletion;
        } else {
          edits.push(ADD);
          j--;
          last = addition;
        }
      }

      edits.reverse();
      return edits;
    }

    var ops = operations(calcEditDistances(current,
                                           currentIndex,
                                           currentLength,
                                           old));

    var splice = undefined;
    var splices = [];
    var index = 0;
    var oldIndex = 0;
    for (var i = 0; i < ops.length; i++) {
      switch(ops[i]) {
        case LEAVE:
          if (splice) {
            splices.push(splice);
            splice = undefined;
          }

          index++;
          oldIndex++;
          break;
        case UPDATE:
          if (!splice)
            splice = newSplice(currentIndex + index, [], 0);

          splice.addedCount++;
          index++;

          splice.removed.push(old[oldIndex]);
          oldIndex++;
          break;
        case ADD:
          if (!splice)
            splice = newSplice(currentIndex + index, [], 0);

          splice.addedCount++;
          index++;
          break;
        case DELETE:
          if (!splice)
            splice = newSplice(currentIndex + index, [], 0);

          splice.removed.push(old[oldIndex]);
          oldIndex++;
          break;
      }
    }

    if (splice) {
      splices.push(splice);
    }

    return splices;
  }

  function createInitialSplicesFromChanges(array, valueChanged) {
    var oldLength = 'length' in valueChanged ? toNumber(valueChanged.length) : array.length;

    var lengthChangeSplice;
    if (array.length > oldLength) {
      lengthChangeSplice = {
        index: oldLength,
        removed: [],
        addedCount: array.length - oldLength
      };
    } else if (array.length < oldLength) {
      lengthChangeSplice = {
        index: array.length,
        removed: new Array(oldLength - array.length),
        addedCount: 0
      };
    }

    var indicesChanged = [];
    Object.keys(valueChanged).forEach(function(prop) {
      var index = toNumber(prop);
      if (isNaN(index) || index < 0 || index >= oldLength)
        return;

      var oldValue = valueChanged[index];
      if (index < array.length)
        indicesChanged[index] = oldValue;
      else
        lengthChangeSplice.removed[index - array.length] = valueChanged[index];
    });

    var splices = [];
    var current;

    for (var index in indicesChanged) {
      index = toNumber(index);

      if (current) {
        if (current.index + current.removed.length == index) {
          current.removed.push(indicesChanged[index]);
          continue;
        }

        current.addedCount = Math.min(array.length, current.index + current.removed.length) - current.index;
        splices.push(current);
        current = undefined;
      }

      current = {
        index: index,
        removed: [indicesChanged[index]]
      }
    }

    if (current) {
      current.addedCount = Math.min(array.length, current.index + current.removed.length) - current.index;

      if (lengthChangeSplice) {
        if (current.index + current.removed.length == lengthChangeSplice.index) {
          // Join splices
          current.addedCount = current.addedCount + lengthChangeSplice.addedCount;
          current.removed = current.removed.concat(lengthChangeSplice.removed);
          splices.push(current);
        } else {
          splices.push(current);
          splices.push(lengthChangeSplice);
        }
      } else {
        splices.push(current)
      }
    } else if (lengthChangeSplice) {
      splices.push(lengthChangeSplice);
    }

    return splices;
  }

  function projectArraySplices(array, valueChanged) {
    var splices = [];

    createInitialSplicesFromChanges(array, valueChanged).forEach(function(splice) {
      splices = splices.concat(calcSplices(array, splice.index, splice.addedCount, splice.removed));
    });

    return splices;
  }

  global.ChangeSummary = ChangeSummary;
})(this);
