const {linkify, UrlMatcher, INVALID_TAGS} = require("linkify-plus-plus-core");

// Valid root node before linkifing
function validRoot(node, validator) {
  // Cache valid state in node.VALID
  if (node.VALID !== undefined) {
    return node.VALID;
  }

  // Loop through ancestor
  var cache = [], isValid;
  while (node != document.documentElement) {
    cache.push(node);

    // It is invalid if it has invalid ancestor
    if (!validator(node) || INVALID_TAGS[node.localName]) {
      isValid = false;
      break;
    }

    // The node was removed from DOM tree
    if (!node.parentNode) {
      return false;
    }

    node = node.parentNode;

    if (node.VALID !== undefined) {
      isValid = node.VALID;
      break;
    }
  }

  // All ancestors are fine
  if (isValid === undefined) {
    isValid = true;
  }

  // Cache the result
  var i;
  for (i = 0; i < cache.length; i++) {
    cache[i].VALID = isValid;
  }

  return isValid;
}

function createValidator({includeElement, excludeElement}) {
  return function(node) {
    if (node.isContentEditable) {
      return false;
    }
    if (node.matches) {
      if (includeElement && node.matches(includeElement)) {
        return true;
      }
      if (excludeElement && node.matches(excludeElement)) {
        return false;
      }
    }
    return true;
  };
}

function createBuffer(size) {
  const set = new Set;
  const buff = Array(size);
  const eventBus = document.createElement("span");
  let start = 0;
  let end = 0;
  return {push, eventBus, shift};
  
  function push(item) {
    if (set.has(item)) {
      return;
    }
    if (set.size && start === end) {
      // overflow
      eventBus.dispatchEvent(new CustomEvent("overflow"));
      set.clear();
      return;
    }
    set.add(item);
    buff[end] = item;
    end = (end + 1) % size;
    eventBus.dispatchEvent(new CustomEvent("add"));
  }
  
  function shift() {
    if (!set.size) {
      return;
    }
    const item = buff[start];
    set.delete(item);
    buff[start] = null;
    start = (start + 1) % size;
    return item;
  }
}

function createLinkifyProcess({options, bufferSize}) {
  const buffer = createBuffer(bufferSize);
  let overflowed = false;
  let started = false;
  buffer.eventBus.addEventListener("add", start);
  buffer.eventBus.addEventListener("overflow", () => overflowed = true);
  return {process};
  
  function process(root) {
    if (overflowed) {
      return false
    }
    if (validRoot(root, options.validator)) {
      buffer.push(root);
    }
    return true;
  }
  
  function start() {
    if (started) {
      return;
    }
    started = true;
    deque();
  }
  
  function deque() {
    let root;
    if (overflowed) {
      root = document.body;
      overflowed = false;
    } else {
      root = buffer.shift();
    }
    if (!root) {
      started = false;
      return;
    }
    
    linkify(root, options)
      .then(() => {
        var p = Promise.resolve();
        if (options.includeElement) {
          for (var node of root.querySelectorAll(options.includeElement)) {
            p = p.then(linkify.bind(null, node, options));
          }
        }
        return p;
      })
      .catch(err => {
        console.error(err);
      })
      .then(deque);
  }
}

function stringToList(value) {
  value = value.trim();
  if (!value) {
    return [];
  }
  return value.split(/\s*\n\s*/g);  
}

function createOptions(pref) {
  const options = {};
  pref.on("change", update);
  update(pref.getAll());
  return options;
  
  function update(changes) {
    Object.assign(options, changes);
    if (changes.includeElement != null || changes.excludeElement != null) {
      options.validator = createValidator(options);
    }
    options.matcher = new UrlMatcher(options);
    options.onlink = options.embedImageExcludeElement ? onlink : null;
    if (typeof options.customRules === "string") {
      options.customRules = stringToList(options.customRules);
    }
  }
  
  function onlink({link, range, content}) {
    if (link.childNodes[0].localName !== "img" || !options.embedImageExcludeElement) {
      return;
    }
    
    var parent = range.startContainer;
    // it might be a text node
    if (!parent.closest) {
      parent = parent.parentNode;
    }
    if (!parent.closest(options.embedImageExcludeElement)) return;
    // remove image
    link.innerHTML = "";
    link.appendChild(content);
  }
}

async function startLinkifyPlusPlus(getPref) {
  // Limit contentType to specific content type
  if (
    document.contentType &&
    !["text/plain", "text/html", "application/xhtml+xml"].includes(document.contentType)
  ) {
    return;
  }
  
  const pref = await getPref();
  const linkifyProcess = createLinkifyProcess({
    options: createOptions(pref),
    bufferSize: 100
  });  
  const observer = new MutationObserver(function(mutations){
    // Filter out mutations generated by LPP
    var lastRecord = mutations[mutations.length - 1],
      nodes = lastRecord.addedNodes,
      i;

    if (nodes.length >= 2) {
      for (i = 0; i < 2; i++) {
        if (nodes[i].className == "linkifyplus") {
          return;
        }
      }
    }

    for (var record of mutations) {
      if (record.addedNodes.length) {
        if (!linkifyProcess.process(record.target)) {
          // it's full
          break;
        }
      }
    }
  });
  await prepareDocument();
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  linkifyProcess.process(document.body);    
}

function prepareDocument() {
  // wait till everything is ready
  return prepareBody().then(prepareApp);
  
  function prepareApp() {
    const appRoot = document.querySelector("[data-server-rendered]");
    if (!appRoot) {
      return;
    }
    return new Promise(resolve => {
      const onChange = () => {
        if (!appRoot.hasAttribute("data-server-rendered")) {
          resolve();
          observer.disconnect();
        }
      };
      const observer = new MutationObserver(onChange);
      observer.observe(appRoot, {attributes: true});
    });
  }
  
  function prepareBody() {
    if (document.readyState !== "loading") {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      // https://github.com/Tampermonkey/tampermonkey/issues/485
      document.addEventListener("DOMContentLoaded", resolve, {once: true});
    });
  }
}

module.exports = {startLinkifyPlusPlus};
