import { useState, useEffect, useRef } from 'react'
import { ElectrumNetworkProvider } from 'cashscript'
import LotteryArtifact from './contracts/Lottery.json'

import { Button } from './components/ui/button'
import { Card } from './components/ui/card'
import { ShieldCheck, Trophy, Ticket, RefreshCw, Dices, Bot, Banknote, Award, Monitor, Wallet, FileCode, CheckCircle2, QrCode } from 'lucide-react'

// Network Config
const provider = new ElectrumNetworkProvider('chipnet')
const TICKET_PRICE_SATS = 100000n // 0.001 BCH

// Swertres Game Definition (3 digits, numbers 0-9)
interface SwertresGame {
  id: string
  name: string
  maxNumber: number
  pickCount: number
  jackpotBch: number
  drawDays: string
}

const SWERTRES_GAME: SwertresGame = {
  id: 'swertres',
  name: 'Swertres Lotto (3D)',
  maxNumber: 9,
  pickCount: 3,
  jackpotBch: 15.0,
  drawDays: 'Daily (2PM, 5PM, 9PM)'
}

interface TicketItem {
  game: string
  numbers: number[]
  txid: string
}

export default function App() {
  const isInitializing = useRef(false)

  // Live Exchange Rate State
  const [bchToPhpRate, setBchToPhpRate] = useState<number | null>(null)

  // Mocknet Wallet State
  const [walletConnected, setWalletConnected] = useState(false)
  const [userBchAddress, setUserBchAddress] = useState('')
  const [walletBalanceSats, setWalletBalanceSats] = useState<bigint>(1000000000n) // 10 BCH Mock Balance
  const [contractBalanceSats, setContractBalanceSats] = useState<bigint>(1500000000n) // 15 BCH Initial Jackpot Pool
  
  // Game & Ticket State
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([])
  const [purchasedTickets, setPurchasedTickets] = useState<TicketItem[]>([])
  
  // Draw Results State
  const [lastWinningNumbers, setLastWinningNumbers] = useState<number[] | null>(null)
  const [drawMessage, setDrawMessage] = useState<string | null>(null)
  const [lastSecret, setLastSecret] = useState<string | null>(null)

  // Testing Force-Win State
  const [forceWinMode, setForceWinMode] = useState(false)

  const [loading, setLoading] = useState(false)
  const [txPending, setTxPending] = useState(false)
  const [drawPending, setDrawPending] = useState(false)

  // 1. Fetch Live BCH to PHP Conversion Rate
  useEffect(() => {
    const fetchBchRate = async () => {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=php')
        const data = await res.json()
        if (data?.['bitcoin-cash']?.php) {
          setBchToPhpRate(data['bitcoin-cash'].php)
        }
      } catch (err) {
        console.warn('Could not fetch live BCH/PHP rate, using fallback:', err)
        setBchToPhpRate(25000)
      }
    }

    fetchBchRate()
    const interval = setInterval(fetchBchRate, 60000)
    return () => clearInterval(interval)
  }, [])

  // 2. Connect Mocknet Local Wallet
  const connectMocknetWallet = () => {
    setLoading(true)
    setTimeout(() => {
      const fakeAddress = 'bchtest:qpm20082t9q86pt326402436d8m57q42as2s4r8322'
      setUserBchAddress(fakeAddress)
      setWalletBalanceSats(1000000000n)
      setWalletConnected(true)
      setLoading(false)
    }, 400)
  }

  // Number Picker Helpers
  const toggleNumber = (num: number) => {
    if (selectedNumbers.length < SWERTRES_GAME.pickCount) {
      setSelectedNumbers([...selectedNumbers, num])
    }
  }

  const removeNumber = (index: number) => {
    const updated = [...selectedNumbers]
    updated.splice(index, 1)
    setSelectedNumbers(updated)
  }

  const handleQuickPick = () => {
    const numbers: number[] = []
    for (let i = 0; i < SWERTRES_GAME.pickCount; i++) {
      const randomNum = Math.floor(Math.random() * (SWERTRES_GAME.maxNumber + 1))
      numbers.push(randomNum)
    }
    setSelectedNumbers(numbers)
  }

  // Buy Ticket Handler
  const handleBuyTicket = async () => {
    if (!walletConnected || selectedNumbers.length !== SWERTRES_GAME.pickCount) return
    setTxPending(true)

    try {
      await new Promise(resolve => setTimeout(resolve, 800))

      setWalletBalanceSats(prev => prev - TICKET_PRICE_SATS)
      setContractBalanceSats(prev => prev + TICKET_PRICE_SATS)

      const mockTxid = 'tx_mocknet_' + Math.random().toString(36).substring(2, 12)

      setPurchasedTickets([
        { game: SWERTRES_GAME.name, numbers: selectedNumbers, txid: mockTxid },
        ...purchasedTickets
      ])

      setSelectedNumbers([])
    } catch (err) {
      console.error('Mocknet transaction evaluation failed:', err)
      alert('Mocknet transaction failed.')
    } finally {
      setTxPending(false)
    }
  }

  // Simulate Draw with Optional Force-Win Testing Hook
  const handleSimulateDraw = async () => {
    if (purchasedTickets.length === 0) {
      alert('Buy at least one ticket before running a draw simulation!')
      return
    }

    setDrawPending(true)
    setDrawMessage(null)
    setLastSecret(null)

    try {
      await new Promise(resolve => setTimeout(resolve, 1200))

      const generatedSecret = 'operator_secret_' + Math.random().toString(36).substring(2, 8)
      setLastSecret(generatedSecret)

      let winningDraw: number[]
      
      // TEST HOOK: If forceWinMode is enabled and user has tickets, force the winning draw to match their latest ticket!
      if (forceWinMode && purchasedTickets.length > 0) {
        winningDraw = [...purchasedTickets[0].numbers]
      } else {
        winningDraw = Array.from({ length: SWERTRES_GAME.pickCount }, () => 
          Math.floor(Math.random() * (SWERTRES_GAME.maxNumber + 1))
        )
      }
      
      setLastWinningNumbers(winningDraw)

      const winningStr = winningDraw.join('')
      const matchingTicket = purchasedTickets.find(t => t.numbers.join('') === winningStr)

      if (matchingTicket) {
        const prizeWonSats = contractBalanceSats
        setWalletBalanceSats(prev => prev + prizeWonSats)
        setContractBalanceSats(0n)
        setDrawMessage(`🎉 JACKPOT WINNER! Your ticket ${winningStr} matched the draw! Prize successfully claimed from contract covenant!`)
      } else {
        setDrawMessage(`❌ No matching tickets found for draw combination ${winningStr}. Covenant pool rolls over to next draw!`)
      }

    } catch (err) {
      console.error('Draw simulation failed:', err)
    } finally {
      setDrawPending(false)
    }
  }

  // Formatting & Conversion Calculations
  const bchBalance = Number(walletBalanceSats) / 1e8
  const phpBalance = bchToPhpRate ? (bchBalance * bchToPhpRate).toLocaleString('en-PH', { maximumFractionDigits: 2 }) : '...'
  
  const contractBchBalance = Number(contractBalanceSats) / 1e8
  const ticketBch = Number(TICKET_PRICE_SATS) / 1e8
  const ticketPhp = bchToPhpRate ? (ticketBch * bchToPhpRate).toFixed(2) : '...'
  const jackpotPhp = bchToPhpRate 
    ? (contractBchBalance * bchToPhpRate).toLocaleString('en-PH', { maximumFractionDigits: 0 }) 
    : '...'

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 flex flex-col justify-between p-4 md:p-8 font-sans selection:bg-emerald-500 selection:text-slate-950">
      
      {/* Top Navigation Header */}
      <header className="max-w-6xl mx-auto w-full flex justify-between items-center py-4 border-b border-slate-800 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
            <ShieldCheck className="h-7 w-7 text-emerald-400" />
          </div>
          <div>
            <h1 className="font-black tracking-wider text-base md:text-lg text-emerald-400 uppercase flex items-center gap-2">
              SWERTRES MOCKNET <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-mono border border-emerald-500/30">Testing Hub</span>
            </h1>
            <p className="text-xs text-slate-400 font-mono">Mocknet Address & Guaranteed Win Simulation</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {walletConnected ? (
            <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-2xl px-4 py-2">
              <Wallet className="h-4 w-4 text-emerald-400" />
              <div className="flex flex-col text-right">
                <span className="text-xs font-mono font-bold text-emerald-400">
                  {bchBalance.toFixed(3)} BCH
                </span>
                <span className="text-[10px] font-mono text-slate-400">
                  ≈ ₱{phpBalance}
                </span>
              </div>
            </div>
          ) : (
            <Button 
              onClick={connectMocknetWallet}
              disabled={loading}
              className="rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm py-2.5 px-5 cursor-pointer shadow-lg shadow-emerald-500/10"
            >
              <Bot className="h-4 w-4 mr-2" /> Connect Mocknet Wallet
            </Button>
          )}
        </div>
      </header>

      {/* Main Responsive Grid Container */}
      <main className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6 my-auto">

        {/* Left / Top Column: Game Banner & Transparency Details */}
        <div className="lg:col-span-2 space-y-6">

          {/* Live Conversion & Status Bar */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between bg-slate-900/80 border border-slate-800/80 rounded-2xl px-4 py-3 text-xs text-slate-400 font-mono">
              <span className="flex items-center gap-2 text-slate-300">
                <Banknote className="h-4 w-4 text-emerald-400" /> 1 BCH Live Rate:
              </span>
              <span className="text-emerald-400 font-bold text-sm">
                {bchToPhpRate ? `₱${bchToPhpRate.toLocaleString('en-PH', { maximumFractionDigits: 2 })}` : 'Loading...'}
              </span>
            </div>

            <div className="flex items-center justify-between bg-slate-900/80 border border-slate-800/80 rounded-2xl px-4 py-3 text-xs text-slate-400 font-mono">
              <span className="flex items-center gap-2 text-slate-300">
                <Monitor className="h-4 w-4 text-emerald-400" /> Environment:
              </span>
              <span className="text-amber-400 font-bold">
                Chipnet Mocknet (Testable)
              </span>
            </div>
          </div>

          {/* Main Prize Banner Card */}
          <Card className="bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/40 border-slate-800 p-6 md:p-8 relative overflow-hidden shadow-2xl">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
              <div>
                <span className="text-xs font-mono text-emerald-400/80 uppercase tracking-widest">Live Covenant Pool Contract</span>
                <h2 className="text-2xl md:text-3xl font-black text-slate-100 mt-1">{SWERTRES_GAME.name}</h2>
              </div>
              <span className="text-xs bg-slate-800 text-amber-300 px-3 py-1 rounded-full font-mono border border-amber-500/20">
                {SWERTRES_GAME.drawDays}
              </span>
            </div>

            <div className="flex items-baseline gap-3 my-4">
              <Trophy className="h-8 w-8 text-amber-400 self-center" />
              <span className="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-emerald-400 to-teal-200">
                ₱{jackpotPhp}
              </span>
            </div>

            <div className="text-sm font-mono text-slate-400 pl-11">
              ({contractBchBalance.toFixed(2)} BCH Total Contract Balance Locked)
            </div>
          </Card>

          {/* Mocknet Address & Guaranteed Win Testing Box */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <QrCode className="h-5 w-5 text-emerald-400" /> Mocknet Wallet & Win Testing Hub
              </span>
              <Button
                onClick={handleSimulateDraw}
                disabled={drawPending || purchasedTickets.length === 0}
                className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2 rounded-xl cursor-pointer disabled:opacity-40 shadow-md shadow-amber-500/10"
              >
                {drawPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Run Verifiable Draw'}
              </Button>
            </div>

            {/* Display Mocknet Address Details */}
            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 space-y-2 font-mono text-xs">
              <div className="text-slate-400 flex items-center justify-between">
                <span>Active Mocknet Address:</span>
                <span className="text-emerald-400 font-bold">{walletConnected ? 'Connected' : 'Disconnected'}</span>
              </div>
              <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-emerald-300 break-all select-all flex items-center justify-between">
                <span>{walletConnected ? userBchAddress : 'bchtest:qpm20082t9q86pt326402436d8m57q42as2s4r8322 (Default Mock Address)'}</span>
                <Button 
                  onClick={() => navigator.clipboard.writeText(walletConnected ? userBchAddress : 'bchtest:qpm20082t9q86pt326402436d8m57q42as2s4r8322')}
                  variant="outline"
                  className="h-7 text-[10px] bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 cursor-pointer ml-2"
                >
                  Copy
                </Button>
              </div>
            </div>

            {/* Guaranteed Win Testing Controls */}
            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-amber-400" /> Force-Win Testing Mode
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    Enables deterministic draw matching so your next ticket purchase is guaranteed to win.
                  </div>
                </div>
                <button
                  onClick={() => setForceWinMode(!forceWinMode)}
                  className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition-all cursor-pointer border ${
                    forceWinMode 
                      ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-lg shadow-amber-500/20' 
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {forceWinMode ? 'FORCE WIN: ON' : 'FORCE WIN: OFF'}
                </button>
              </div>
            </div>

            {lastWinningNumbers && (
              <div className="space-y-3 pt-3 border-t border-slate-800 text-xs font-mono">
                <div className="flex justify-between items-center bg-slate-950/80 p-3 rounded-xl border border-slate-800">
                  <span className="text-slate-400">Winning Combination:</span>
                  <div className="flex gap-1.5">
                    {lastWinningNumbers.map((n, i) => (
                      <span key={i} className="px-2.5 py-1 bg-amber-400/20 text-amber-300 border border-amber-500/30 rounded font-black text-sm">
                        {n}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-1.5">
                  <div className="text-slate-400 flex items-center gap-1 font-bold text-[11px] uppercase tracking-wider text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Entropy Proofs (`resolveDraw`)
                  </div>
                  <div className="text-slate-300 break-all text-[11px]">
                    <span className="text-slate-500">Secret Revealed:</span> {lastSecret}
                  </div>
                </div>
              </div>
            )}

            {drawMessage && (
              <div className={`p-3.5 rounded-xl text-xs md:text-sm font-medium border ${drawMessage.includes('JACKPOT') ? 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300' : 'bg-slate-950 border-slate-800 text-slate-400'}`}>
                {drawMessage}
              </div>
            )}
          </div>

        </div>

        {/* Right Column: Ticket Buying & Number Picker Control Hub */}
        <div className="space-y-6">

          {/* Number Selection Grid Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
            <div className="flex justify-between items-center">
              <div className="text-sm text-slate-200 font-bold">
                Pick <span className="text-emerald-400">3 digits (0-9)</span>
              </div>
              
              <Button
                onClick={handleQuickPick}
                variant="outline"
                className="h-8 text-xs bg-slate-800 border-slate-700 text-emerald-300 hover:bg-slate-700 rounded-xl cursor-pointer"
              >
                <Dices className="h-3.5 w-3.5 mr-1.5" /> Quick Pick
              </Button>
            </div>

            {/* Selected Combination Slots Display */}
            <div className="flex flex-col items-center gap-2 p-4 bg-slate-950/60 border border-slate-800/80 rounded-xl">
              <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">Your Combination</span>
              <div className="flex gap-3">
                {[0, 1, 2].map(idx => (
                  <button
                    key={idx}
                    onClick={() => removeNumber(idx)}
                    className={`h-12 w-12 rounded-xl border font-black text-lg flex items-center justify-center transition-all ${
                      selectedNumbers[idx] !== undefined 
                        ? 'bg-emerald-400 text-slate-950 border-emerald-400 shadow-lg shadow-emerald-400/20' 
                        : 'bg-slate-900 border-slate-800 text-slate-600 border-dashed hover:border-slate-700'
                    }`}
                  >
                    {selectedNumbers[idx] !== undefined ? selectedNumbers[idx] : '-'}
                  </button>
                ))}
              </div>
              {selectedNumbers.length > 0 && (
                <button 
                  onClick={() => setSelectedNumbers([])} 
                  className="text-xs text-rose-400 hover:underline mt-1 font-mono cursor-pointer"
                >
                  Clear Combination
                </button>
              )}
            </div>

            {/* Digits Grid 0-9 */}
            <div className="grid grid-cols-5 gap-2.5">
              {Array.from({ length: 10 }, (_, i) => i).map(num => (
                <button
                  key={num}
                  onClick={() => toggleNumber(num)}
                  disabled={selectedNumbers.length >= SWERTRES_GAME.pickCount}
                  className="h-12 rounded-xl text-lg font-black transition-all cursor-pointer flex items-center justify-center bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700/60 active:scale-95 disabled:opacity-40 shadow-sm"
                >
                  {num}
                </button>
              ))}
            </div>

            {/* Action Purchase Button */}
            <div className="pt-2">
              {!walletConnected ? (
                <Button 
                  onClick={connectMocknetWallet}
                  disabled={loading}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base py-6 rounded-xl shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  CONNECT MOCKNET WALLET TO PLAY
                </Button>
              ) : (
                <Button 
                  onClick={handleBuyTicket}
                  disabled={txPending || selectedNumbers.length !== SWERTRES_GAME.pickCount} 
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base py-6 rounded-xl shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition-transform cursor-pointer disabled:opacity-50"
                >
                  {txPending ? (
                    <RefreshCw className="h-5 w-5 animate-spin" />
                  ) : selectedNumbers.length !== SWERTRES_GAME.pickCount ? (
                    `PICK ${SWERTRES_GAME.pickCount - selectedNumbers.length} MORE DIGITS`
                  ) : (
                    `BUY SWERTRES TICKET (0.001 BCH ≈ ₱${ticketPhp})`
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Active Purchased Tickets List */}
          {purchasedTickets.length > 0 && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-2">
                <Ticket className="h-4 w-4 text-emerald-400" /> Active Tickets ({purchasedTickets.length})
              </span>
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {purchasedTickets.map((t, idx) => (
                  <div key={idx} className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-xs flex justify-between items-center">
                    <div>
                      <span className="font-bold text-emerald-400">{t.game}: </span>
                      <span className="font-mono tracking-widest text-slate-200 text-base font-black ml-1">{t.numbers.join('')}</span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">{t.txid.slice(0, 14)}...</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto w-full text-center py-6 border-t border-slate-800/80 mt-8 text-xs text-slate-500 font-mono">
        Swertres On-Chain Decentralized Lottery • Powered by CashScript & Bitcoin Cash (BCH)
      </footer>

    </div>
  )
}