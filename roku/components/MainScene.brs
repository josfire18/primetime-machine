' The Roku channel: a thin client of the station on the home network. It asks the station
' what a channel is airing (the same clock-computed playout every screen gets), plays the
' station's files directly, and keeps checking the picture against the clock twice a second.
'
' Remote: Up/Down change channel, OK opens the guide (OK again watches), Back closes it,
' * shows what's on (or, with no station found, sets the station's address).

sub init()
    m.tv = m.top.FindNode("tv")
    m.card = m.top.FindNode("card")
    m.osd = m.top.FindNode("osd")
    m.infobar = m.top.FindNode("infobar")
    m.guide = m.top.FindNode("guide")
    m.grid = m.top.FindNode("grid")
    m.tick = m.top.FindNode("tick")
    m.osdTimer = m.top.FindNode("osdTimer")
    m.infoTimer = m.top.FindNode("infoTimer")

    m.channels = []
    m.index = 0
    m.segments = invalid
    m.current = invalid
    m.playingUrl = ""
    m.token = 0
    m.refetching = false
    m.launched = false
    m.tasks = {}
    m.noStation = false

    m.tick.ObserveField("fire", "onTick")
    m.osdTimer.ObserveField("fire", "onOsdTimer")
    m.infoTimer.ObserveField("fire", "onInfoTimer")
    m.tv.ObserveField("state", "onVideoState")
    m.grid.ObserveField("programFocused", "onGuideFocus")
    m.grid.ObserveField("channelFocused", "onGuideFocus")
    m.grid.ObserveField("programSelected", "onGuideSelect")

    m.registry = CreateObject("roRegistrySection", "PrimetimeMachine")
    m.base = m.registry.Read("station")
    m.top.SetFocus(true)
    if m.base = "" then
        askStation()
    else
        start()
    end if
end sub

' ------------------------------------------------------------------ the station
sub start()
    showCard("Tuning in", m.base)
    request("channels", "/api/channels")
end sub

sub askStation()
    m.noStation = true
    showCard("Where's your station?", "Turn on sharing in Primetime Machine on your computer, then enter its address")
    dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
    dlg.title = "Station address"
    dlg.message = ["The address the desktop app shows under File > Addresses for other screens, like 192.168.1.20:8420"]
    dlg.buttons = ["OK", "Cancel"]
    host = m.base.Replace("http://", "")
    dlg.text = host
    dlg.ObserveField("buttonSelected", "onStationEntered")
    m.top.dialog = dlg
end sub

sub onStationEntered()
    dlg = m.top.dialog
    if dlg.buttonSelected = 0 then
        text = dlg.text.Trim()
        if text <> "" then
            if Left(text, 7) <> "http://" then text = "http://" + text
            if Instr(8, text, ":") = 0 then text = text + ":8420"
            m.base = text
            m.registry.Write("station", m.base)
            m.registry.Flush()
        end if
    end if
    dlg.close = true
    m.top.SetFocus(true)
    if m.base <> "" then
        m.noStation = false
        start()
    end if
end sub

sub request(tag as String, path as String)
    task = CreateObject("roSGNode", "StationTask")
    task.tag = tag
    task.url = m.base + path
    task.ObserveField("response", "onResponse")
    m.tasks[tag] = task          ' keep it alive until it answers
    task.control = "RUN"
end sub

sub onResponse(evt as Object)
    res = evt.GetData()
    m.tasks.Delete(res.tag)
    if not res.ok then
        if res.tag = "guide" then
            m.top.FindNode("gTitle").text = "The guide is unavailable"
            return
        end if
        m.noStation = true
        showCard("No signal", res.error + ". Press * to change the station address.")
        return
    end if
    m.noStation = false
    if res.tag = "channels" then
        m.channels = res.data.channels
        if m.channels.Count() = 0 then
            showCard("No channels yet", "Add your video folders in Primetime Machine on your computer")
            return
        end if
        saved = m.registry.Read("channel")
        m.index = 0
        for i = 0 to m.channels.Count() - 1
            if m.channels[i].id = saved then m.index = i
        end for
        m.tick.control = "start"
        tune(m.index)
    else if Left(res.tag, 8) = "playout:" then
        if res.tag <> "playout:" + m.token.ToStr() then return      ' a channel we've left
        m.segments = res.data.segments
        m.refetching = false
        playNow()
        showInfo()
    else if res.tag = "guide" then
        buildGuide(res.data)
    end if
end sub

' ------------------------------------------------------------------ tuning and playback
sub tune(i as Integer)
    if m.channels.Count() = 0 then return
    m.index = i
    m.token = m.token + 1
    ch = m.channels[m.index]
    showOsd(ch.number.ToStr())
    m.tv.control = "stop"
    m.playingUrl = ""
    m.current = invalid
    m.segments = invalid
    m.card.visible = false
    t# = NowMs()
    request("playout:" + m.token.ToStr(), "/api/playout?channel=" + ch.id.EncodeUriComponent() + "&from=" + Str(t#).Trim() + "&to=" + Str(t# + 5400000#).Trim())
    m.registry.Write("channel", ch.id)
    m.registry.Flush()
end sub

sub playNow()
    t# = NowMs()
    seg = SegmentAt(m.segments, t#)
    if seg = invalid then
        if not m.refetching and m.channels.Count() > 0 then
            m.refetching = true          ' ran past what we fetched: get the next stretch
            ch = m.channels[m.index]
            request("playout:" + m.token.ToStr(), "/api/playout?channel=" + ch.id.EncodeUriComponent() + "&from=" + Str(t#).Trim() + "&to=" + Str(t# + 5400000#).Trim())
        end if
        return
    end if
    m.current = seg
    if not Plays(seg) then
        m.tv.control = "stop"
        m.playingUrl = ""
        if seg.program <> invalid then
            showCard("We'll be right back", ProgramLabel(seg.program))
        else
            showCard("Station break", m.channels[m.index].name)
        end if
        return
    end if
    m.card.visible = false
    url = MediaUrl(m.base, seg.src)
    at = OffsetSec(seg, t#)
    if url <> m.playingUrl then
        content = CreateObject("roSGNode", "ContentNode")
        content.url = url
        content.streamFormat = "mp4"
        content.PlayStart = at
        m.tv.content = content
        m.tv.control = "play"
        m.playingUrl = url
    else
        m.tv.seek = at
    end if
end sub

sub onTick()
    if m.segments = invalid then return
    t# = NowMs()
    if m.current = invalid or t# >= m.current.end then
        playNow()
    else if Plays(m.current) and m.tv.state = "playing" then
        expected = OffsetSec(m.current, t#)
        if Abs(m.tv.position - expected) > 2 then m.tv.seek = expected
    end if
    if m.infobar.visible then updateInfo()
end sub

sub onVideoState()
    if m.tv.state = "error" then
        showCard("No signal", "This file can't be played on the Roku")
    else if m.tv.state = "playing" and not m.launched then
        m.launched = true
        m.top.signalBeacon("AppLaunchComplete")
    end if
end sub

' ------------------------------------------------------------------ overlays
sub showCard(title as String, subtitle as String)
    m.top.FindNode("cardTitle").text = title
    m.top.FindNode("cardSub").text = subtitle
    m.card.visible = true
end sub

sub showOsd(text as String)
    m.osd.text = text
    m.osd.visible = true
    m.osdTimer.control = "stop"
    m.osdTimer.control = "start"
end sub

sub onOsdTimer()
    m.osd.visible = false
end sub

sub showInfo()
    if m.channels.Count() = 0 then return
    ch = m.channels[m.index]
    m.top.FindNode("ibNum").text = ch.number.ToStr()
    m.top.FindNode("ibName").text = UCase(ch.name)
    p = invalid
    if m.current <> invalid then p = m.current.program
    m.top.FindNode("ibTitle").text = ProgramLabel(p)
    meta = ProgramDetail(p)
    nextText = ""
    if m.current <> invalid and m.current.block <> invalid then
        b = m.current.block
        slot = ClockText(b.start) + " - " + ClockText(b.end)
        if meta <> "" then meta = meta + "   " + slot else meta = slot
        for each s in m.segments
            if s.start >= b.end then
                nextText = "Up next: " + ProgramLabel(s.program)
                exit for
            end if
        end for
    end if
    m.top.FindNode("ibMeta").text = meta
    m.top.FindNode("ibNext").text = nextText
    updateInfo()
    m.infobar.visible = true
    m.infoTimer.control = "stop"
    m.infoTimer.control = "start"
end sub

sub updateInfo()
    t# = NowMs()
    m.top.FindNode("ibClock").text = ClockText(t#)
    width = 0
    if m.current <> invalid and m.current.block <> invalid then
        b = m.current.block
        frac = (t# - b.start) / (b.end - b.start)
        if frac < 0 then frac = 0
        if frac > 1 then frac = 1
        width = Int(1100 * frac)
    end if
    m.top.FindNode("ibBar").width = width
end sub

sub onInfoTimer()
    m.infobar.visible = false
end sub

' ------------------------------------------------------------------ guide
sub openGuide()
    m.top.signalBeacon("EPGLaunchInitiate")
    m.guide.visible = true
    m.infobar.visible = false
    m.top.FindNode("gTitle").text = "Loading the guide"
    m.top.FindNode("gMeta").text = ""
    t# = NowMs()
    from# = Int(t# / 1800000#) * 1800000#
    m.guideFrom = from#
    request("guide", "/api/guide?from=" + Str(from#).Trim() + "&to=" + Str(from# + 10800000#).Trim())
end sub

sub buildGuide(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    for each ch in m.channels
        row = root.CreateChild("ContentNode")
        row.title = ch.number.ToStr() + "  " + ch.name
        for each c in data.channels
            if c.id = ch.id then
                for each b in c.blocks
                    p = row.CreateChild("ContentNode")
                    p.title = ProgramLabel(b.program)
                    p.description = ProgramDetail(b.program)
                    p.PLAYSTART = Int(b.start / 1000#)
                    p.PLAYDURATION = Int((b.end - b.start) / 1000#)
                end for
            end if
        end for
    end for
    m.grid.contentStartTime = Int(m.guideFrom / 1000#)
    m.grid.content = root
    m.grid.jumpToChannel = m.index
    m.grid.SetFocus(true)
    onGuideFocus()
    m.top.signalBeacon("EPGLaunchComplete")
end sub

function focusedProgram() as Object
    if m.grid.content = invalid then return invalid
    row = m.grid.content.GetChild(m.grid.channelFocused)
    if row = invalid then return invalid
    return row.GetChild(m.grid.programFocused)
end function

sub onGuideFocus()
    p = focusedProgram()
    if p = invalid then return
    m.top.FindNode("gTitle").text = p.title
    row = m.grid.content.GetChild(m.grid.channelFocused)
    start# = p.PLAYSTART * 1000#
    slot = ClockText(start#) + " - " + ClockText(start# + p.PLAYDURATION * 1000#)
    detail = row.title + "   " + slot
    if p.description <> "" then detail = detail + "   " + p.description
    m.top.FindNode("gMeta").text = detail
end sub

sub onGuideSelect()
    closeGuide()
    if m.grid.channelFocused <> m.index then
        tune(m.grid.channelFocused)
    else
        showInfo()
    end if
end sub

sub closeGuide()
    m.guide.visible = false
    m.top.SetFocus(true)
end sub

' ------------------------------------------------------------------ remote
function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if m.guide.visible then
        if key = "back" then
            closeGuide()
            return true
        end if
        return false             ' the grid handles its own arrows and OK
    end if
    if key = "options" then
        if m.noStation then
            askStation()
        else
            showInfo()
        end if
        return true
    end if
    if m.channels.Count() = 0 then return false
    if key = "up" or key = "right" then
        tune(StepChannel(m.index, m.channels.Count(), 1))
        return true
    else if key = "down" or key = "left" then
        tune(StepChannel(m.index, m.channels.Count(), -1))
        return true
    else if key = "OK" then
        openGuide()
        return true
    else if key = "play" then
        showInfo()
        return true
    end if
    return false
end function
