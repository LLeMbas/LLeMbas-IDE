-- JSON-RPC 2.0 over lines on a child process's stdin and stdout: the framing ACP uses on stdio.
local M = {}
M.__index = M

--- Start `cmd` and speak JSON-RPC with it. `on.request(method, params, reply)` and
--- `on.notify(method, params)` run on the main loop; `on.exit(code, stderr)` when the process ends.
function M.start(cmd, on, opts)
  local self = setmetatable({ next_id = 1, waiting = {}, on = on, buf = "", err = {}, closed = false }, M)
  local ok, proc = pcall(vim.system, cmd, {
    stdin = true,
    cwd = opts and opts.cwd or nil,
    env = opts and opts.env or nil,
    stdout = function(_, data) if data then self:_feed(data) end end,
    stderr = function(_, data)
      if data then
        self.err[#self.err + 1] = data
        while #self.err > 40 do table.remove(self.err, 1) end
      end
    end,
  }, function(res)
    vim.schedule(function()
      self.closed = true
      local waiting = self.waiting
      self.waiting = {}
      for _, cb in pairs(waiting) do cb({ code = -32000, message = "the agent stopped" }, nil) end
      if on.exit then on.exit(res.code, table.concat(self.err)) end
    end)
  end)
  if not ok then return nil, tostring(proc) end
  self.proc = proc
  return self
end

function M:_feed(data)
  self.buf = self.buf .. data
  while true do
    local nl = self.buf:find("\n", 1, true)
    if not nl then break end
    local line = self.buf:sub(1, nl - 1)
    self.buf = self.buf:sub(nl + 1)
    if line:match("%S") then
      local ok, msg = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
      if ok and type(msg) == "table" then vim.schedule(function() self:_message(msg) end) end
    end
  end
end

function M:_message(msg)
  if msg.method then
    if msg.id ~= nil then
      local answered = false
      local function reply(result, err)
        if answered then return end
        answered = true
        if err then self:_write({ jsonrpc = "2.0", id = msg.id, error = err })
        else self:_write({ jsonrpc = "2.0", id = msg.id, result = result == nil and vim.NIL or result }) end
      end
      local ok, e = pcall(self.on.request, msg.method, msg.params or {}, reply)
      if not ok then reply(nil, { code = -32603, message = tostring(e) }) end
    elseif self.on.notify then
      pcall(self.on.notify, msg.method, msg.params or {})
    end
  elseif msg.id ~= nil then
    local cb = self.waiting[msg.id]
    self.waiting[msg.id] = nil
    if cb then cb(msg.error, msg.result) end
  end
end

function M:_write(msg)
  if self.closed then return end
  pcall(function() self.proc:write(vim.json.encode(msg) .. "\n") end)
end

--- A request; `cb(err, result)` on the main loop.
function M:request(method, params, cb)
  if self.closed then return cb and cb({ code = -32000, message = "the agent is not running" }, nil) end
  local id = self.next_id
  self.next_id = id + 1
  self.waiting[id] = cb or function() end
  self:_write({ jsonrpc = "2.0", id = id, method = method, params = params })
  return id
end

function M:notify(method, params)
  self:_write({ jsonrpc = "2.0", method = method, params = params })
end

function M:stop()
  if self.closed then return end
  pcall(function() self.proc:write(nil) end)
  pcall(function() self.proc:kill(15) end)
end

return M
