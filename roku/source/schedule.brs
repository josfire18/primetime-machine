' The clock math the channel shares with the station: what airs now, and where in it.
' Times are epoch milliseconds as Doubles (they don't fit a 32-bit Integer; a Double holds
' them exactly), offsets are seconds.

' Milliseconds since the epoch, from the box's clock (set by the network, like the station's).
function NowMs() as Double
    dt = CreateObject("roDateTime")
    dt.Mark()
    secs# = dt.AsSeconds()
    return secs# * 1000# + dt.GetMilliseconds()
end function

' The segment airing at `t`, or invalid when the list doesn't cover it.
function SegmentAt(segments as Object, t as Double) as Object
    if segments = invalid then return invalid
    for each s in segments
        if t >= s.start and t < s.end then return s
    end for
    return invalid
end function

' Seconds into the segment's file at `t`.
function OffsetSec(seg as Object, t as Double) as Double
    return seg.fromSec + (t - seg.start) / 1000#
end function

' Whether `seg` plays a file (program or ad) or shows a card (filler, station break).
function Plays(seg as Object) as Boolean
    return seg <> invalid and seg.src <> invalid and seg.role <> "filler"
end function

' The station's relative media path made absolute.
function MediaUrl(base as String, src as String) as String
    if Left(src, 4) = "http" then return src
    b = base
    if Right(b, 1) = "/" then b = Left(b, Len(b) - 1)
    return b + src
end function

' "8:05 PM" from epoch ms, in the box's time zone.
function ClockText(t as Double) as String
    dt = CreateObject("roDateTime")
    dt.FromSeconds(Int(t / 1000#))
    dt.ToLocalTime()
    h = dt.GetHours()
    m = dt.GetMinutes()
    ampm = "AM"
    if h >= 12 then ampm = "PM"
    h = h mod 12
    if h = 0 then h = 12
    mm = m.ToStr()
    if m < 10 then mm = "0" + mm
    return h.ToStr() + ":" + mm + " " + ampm
end function

' What the info bar says about a program.
function ProgramLabel(p as Object) as String
    if p = invalid then return "Station break"
    if p.show <> invalid then return p.show
    return p.title
end function

function ProgramDetail(p as Object) as String
    if p = invalid then return ""
    parts = []
    if p.show <> invalid and p.title <> invalid then parts.Push(Chr(34) + p.title + Chr(34))
    if p.season <> invalid and p.episode <> invalid then parts.Push("S" + p.season.ToStr() + " E" + p.episode.ToStr())
    if p.year <> invalid then parts.Push(p.year.ToStr())
    out = ""
    for each x in parts
        if out <> "" then out = out + "  " + Chr(183) + "  "
        out = out + x
    end for
    return out
end function

' The next channel index, wrapping: step is +1 or -1.
function StepChannel(index as Integer, count as Integer, stepBy as Integer) as Integer
    if count = 0 then return 0
    return ((index + stepBy) mod count + count) mod count
end function
