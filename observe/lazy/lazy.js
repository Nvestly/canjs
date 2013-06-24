steal('can/util','can/observe','./nested_reference',function(can){
	
	var canMakeObserve = function( obj ) {
		// returns `true` if something should/could be converted to can.Observe
		return obj && !can.isDeferred(obj) && (can.isArray(obj) || can.isPlainObject( obj ) || ( obj instanceof can.Observe ));
	},
		convertAndWireUp = function(){
			
		},
		makeObserve = function(child, parent){
			if (child instanceof can.Observe){
				// We have an `observe` already...
				// Make sure it is not listening to this already
				// It's only listening if it has bindings already.
				parent._bindings && unhookup([child], parent._cid);
			} else if ( can.isArray(child) ) {
				// else if array create LazyList
				child = new can.LazyList(child);
			} else if( canMakeObserve(child) ) {
				// or try to make LazyMap
				child = new can.LazyMap(child);
			} 
			return child;
		},
		attrParts = function(attr, keepKey) {
			if(keepKey) {
				return [attr];
			}
			// break attr path into array
			return can.isArray(attr) ? attr : (""+attr).split(".");
		},
		isObserve = function( obj ){
			return obj instanceof can.Observe	
		},
		isPrimitive = function( obj ) {
			return typeof obj === "number" || typeof obj === "string"
		},
		bindToChildAndBubbleToParent = function(child, ref, parent){
			// binds on child and triggers event on parent --> bubbles events from child to parent
			child.bind("change" + parent._cid, 
					   function( /* ev, attr */ ) {
						   // `batchTrigger` the type on this...
						   var args = can.makeArray(arguments),
							   ev = args.shift();

						   // update path
						   args[0] = [ ref(), args[0]].join(".");

						   // track objects dispatched on this observe		
						   ev.triggeredNS = ev.triggeredNS || {};

						   // if it has already been dispatched exit
						   if (ev.triggeredNS[parent._cid]) {
							   return;
						   }

						   ev.triggeredNS[parent._cid] = true;
						   // send change event with modified attr to parent	
						   can.trigger(parent, ev, args);
						   // send modified attr event to parent
						   //can.trigger(parent, args[0], args);
					   });
		},
		unhookup = function(items, namespace){
			// unbind listeners on `items`
			return can.each(items, function(item){
				if(item && item.unbind){
					item.unbind("change" + namespace);
				}
			});
		},
		makeBindSetup = function(wildcard){
			return function(){
				var parent = this;
				can.each(this._nestedObserves, function(child, prop){
					if(child && child.bind){
						bindToChildAndBubbleToParent(child, wildcard || prop, parent)
					}
				})
			};
		};
	
	can.LazyMap = can.Observe({
		setup: function( obj ) {
			// keep 'plain' object in `_data` 
			this._data = obj;
			
			// keep references to Observes in `_data`
			this._nestedReference = new can.NestedReference(this._data);
			
			// The namespace this `object` uses to listen to events.
			can.cid(this, ".observe");
			
			// Sets all `attrs`.
			this._init = 1;
			this.bind('change'+this._cid,can.proxy(this._changes,this));
			delete this._init;

			// Add properties directly on object for easy access;
			for( var key in obj ) {
				// do not overwrite existing methods on prototype
				if( !(key in this.constructor.prototype) ) {
					this[key] = obj[key];
				}
			}
		},
		_bindsetup: function(){
			var parent = this;

			// Bind on all nested observes in reference list.
			this._nestedReference.each(function(child, ref){
				if(child && child.bind){
					bindToChildAndBubbleToParent(child, ref, parent)
				}
			});			
		},
		_bindteardown: function(){
			var cid = this._cid;

			// Remove bindings from all nested observes in reference list.
			this._nestedReference.each(function(child, ref){
				unhookup([child], cid)
			})
		},

		// todo: function should be renamed
		_addChild: function(path, newChild, setNewChild){
			var self = this;

			// remove 'old' references that are starting with `path` and do rewiring
			this._nestedReference.removeChildren(path, function(oldChild, oldChildPath){
				// unhook every current child on path
				unhookup([oldChild], self._cid);

				// if `newChild` passed bind it to every child and make references (1st step: rewiring to bottom/children)
				if(newChild){
					var newChildPath = oldChildPath.replace(path+".", "");
					
					// check if we are replacing existing observe or inserting new one
					if( path === newChildPath ) {
						//
						oldChild._nestedReference.each(function( obj, path ) {
							newChild._nestedReference.make( path );
							self._bindings && bindToChildAndBubbleToParent(obj, path, newChild);
						});
						//
					} else {
						var reference = newChild._nestedReference.make( newChildPath );
						self._bindings && bindToChildAndBubbleToParent(oldChild, reference, newChild);
					}
					
				}
			})

			// callback
			setNewChild && setNewChild()
			
			// bind parent on `newChild` and make reference (2st step: rewiring to top/parent)
			if(newChild){
				var reference = this._nestedReference.make( path );
				this._bindings && bindToChildAndBubbleToParent(newChild, reference,this);
			}
			return newChild;
		},
		
		removeAttr: function( attr ) {
			var data = this._goto(attr);

			// if there are more attr parts remaining, it means we
			// hit an internal observable
			if( data.parts.length ){
				// ask that observable to remove the attr
				return data.value.removeAttr( data.parts.join(".") )
			} else {
				// otherwise, are we removing a property from an array
				if(can.isArray(data.parent)){
					data.parent.splice(data.prop,1);
					this._triggerChange(attr, "remove", undefined, [makeObserve(data.value, this)]);
				} else {
					delete data.parent[data.prop];
					can.Observe.triggerBatch(this, data.path.length? data.path.join(".")+".__keys" : "__keys");
					this._triggerChange(attr, "remove", undefined, makeObserve( data.value, this) );
				}
				// unhookup anything that was in here
				//this._addChild(attr); // --> CHECK THIS ONE! (previous bug was causing this to work even if it shouldn't,)
				// instead remove all references, do not unbind as _addChild does
				this._nestedReference.removeChildren();
				return data.value;
			}
		},
		// walks to a property on the lazy map
		// if it finds an object, uses [] to follow properties
		// if it finds something else, it uses __get
		_goto: function(attr){
			var parts = attrParts(attr),
				prev,
				path = [],
				part;			

			// are we dealing with list or map
			var cur = this instanceof can.Observe.List ? this[parts.shift()] : this.__get();

			while(cur && !isObserve(cur) && parts.length){
				part !== undefined && path.push(part)
				prev = cur;
				cur = cur[part = parts.shift()];				
			}
			
			return {
				parts: parts,
				prop: part,
				value: cur,
				parent: prev,
				path: path
			}
		},
		// Reads a property from the `object`.
		_get: function( attr ) {
			var data = this._goto(attr);

			// if it's already observe return it
			if( isObserve(data.value) ){
				if( data.parts.length ){
					return data.value._get(data.parts)	
				} else {
					return data.value;	
				}
			} else if (data.value && canMakeObserve(data.value)){
				// if object create LazyMap/LazyList
				var converted;
				if(can.isArray(data.value)){
					converted = new can.LazyList(data.value)
				} else {
					converted = new can.LazyMap(data.value)	
				}
				// ... and replace it
				this._addChild(attr, converted, function(){
					data.parent[data.prop] = converted;
				})
				return converted;
			} else {
				return data.value;	
			}
		},
		// Reads a property directly if an `attr` is provided, otherwise
		// returns the "real" data object itself.
		__get: function( attr ) {
			return attr ? this._data[attr] : this._data;
		},
		// Sets `attr` prop as value on this object where.
		// `attr` - Is a string of properties or an array  of property values.
		// `value` - The raw value to set.
		_set: function( attr, value, keepKey) {
			var data = this._goto(attr);
			
			if(isObserve(data.value) && data.parts.length){
				return data.value._set(data.parts, value)	
			} else if(!data.parts.length) {
				this.__set(attr, value, data.value, data)
			} else {
				throw "can.LazyMap: object does note exist"
			}
		},
		__set : function(prop, value, current, data, convert){
			// Otherwise, we are setting it on this `object`.
			// TODO: Check if value is object and transform
			// are we changing the value.

			// maybe not needed at all
			convert = convert || true;

			if ( value !== current ) {
				// Check if we are adding this for the first time --
				// if we are, we need to create an `add` event.

				var changeType = data.parent.hasOwnProperty( data.prop ) ? "set" : "add";

				// if it is or should be a Lazy
				if( convert && canMakeObserve(value) ) {
					// make it a lazy
					value = makeObserve(value, this);
					var self = this;
					// hook up it's bindings
					this._addChild(prop, value, function(){
						// set the value
						self.___set(prop, value, data)
					})
				} else {
					// just set the value
					this.___set(prop,value, data)
				}

				if(changeType == "add"){
					// If there is no current value, let others know that
					// the the number of keys have changed
					
					can.Observe.triggerBatch(this, data.path.length? data.path.join(".")+".__keys" : "__keys", undefined);
					
				}
				// `batchTrigger` the change event.
				this._triggerChange(prop, changeType, value, current);
			}
		},
		// Directly sets a property on this `object`.
		___set: function( prop, val, data ) {
			if(data){
				data.parent[data.prop] = val;
			} else {
				this._data[prop] = val;
			}
		},
		/**
		 * @hide
		 * Set multiple properties on the observable
		 * @param {Object} props
		 * @param {Boolean} remove true if you should remove properties that are not in props
		 */
		_attrs: function( props, remove ) {

			if ( props === undefined ) {	
				return serialize(this, 'attr', {})
			}

			props = can.extend({}, props);
			var self = this,
				prop,
				data,
				newVal;

			can.Observe.startBatch();

			// Update existing props
			this.each(function( curVal, prop ){
				newVal = props[prop];
				data = self._goto(prop);

				// remove existing prop and return if there is no new prop to merge and `remove` param exists
				if ( newVal === undefined ) {
					remove && self.removeAttr(prop);
					return;
				} else if( !isObserve(curVal) && canMakeObserve(curVal) ) {
					// convert curVal to observe
					curVal = self.attr(prop);
				}

				//
				if(self.__convert){
					newVal = self.__convert(prop, newVal)
				}

				// if we're dealing with models, want to call _set to let converter run
				if( newVal instanceof can.Observe ) {
					self.__set(prop, newVal, curVal, data)
					// if its an object, let attr merge
				} else if ( canMakeObserve(curVal) && canMakeObserve(newVal) && curVal.attr ) {
					curVal.attr(newVal, remove)
					// otherwise just set
				} else if ( curVal != newVal ) {
					// OK till here
					self.__set(prop, newVal, curVal, data)
				}
				
				// delete passed prop after setting
				delete props[prop];
			})
			
			// add remaining props
			for ( prop in props ) {
				newVal = props[prop];
				this._set(prop, newVal, true)
			}

			can.Observe.stopBatch()
			return this;
		}
	});
	
	
	can.LazyList = can.Observe.List(
		{
			hookupBubble: function( child, prop, parent, indexHint ) {
				var Ob = parent.constructor.Observe || can.LazyMap;
				var List = (parent.constructor instanceof can.Observe.List && parent.constructor) || can.LazyList;
				
				// If it's an `array` make a list, otherwise a child.
				if (child instanceof can.Observe){
					// We have an `observe` already...
					// Make sure it is not listening to this already
					// It's only listening if it has bindings already.
					parent._bindings && unhookup([child], parent._cid);
				} else if ( can.isArray(child) ) {
					child = new can.LazyList(child);
				} else {
					child = new can.LazyMap(child);
				}
				
				// add reference manually
				
				var reference = function(){
					return ""+parent.indexOf(child)
				};
				
				parent._nestedReference.references.push(reference)
				
				
				// only listen if something is listening to you
				if(parent._bindings){
					// Listen to all changes and `batchTrigger` upwards.
					bindToChildAndBubbleToParent(child, reference, parent)
				}
				

				return child;
			},
			unhookup: function(items, namespace, index, parent){
				return can.each(items, function(item){
					if(item && item.unbind){
						item.unbind("change" + namespace);
					}
				});
				for(var i = index; i < index+items.length; i++){
					// unbinds everything
					parent._addChild(""+i)
				}				
			}
		}, {
			setup: function( instances, options ) {
				this._nestedReference = new can.NestedReference(this);
				
				// TODO: currently all items get converted to observes
				can.Observe.List.prototype.setup.apply(this,arguments)
			},
			_goto: can.LazyMap.prototype._goto,
			removeAttr: can.LazyMap.prototype.removeAttr,
			_bindsetup: can.LazyMap.prototype._bindsetup,
			_bindteardown: can.LazyMap.prototype._bindteardown,
			_addChild: can.LazyMap.prototype._addChild,
			___set : function(attr, val, data){
				if(data){
					data.parent[data.prop] = val;
				} else {
					return can.Observe.List.prototype.___set.apply(this, arguments)
				}
			}
			
		})
	
	
	
})