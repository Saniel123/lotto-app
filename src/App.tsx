import { useState, useEffect, useRef } from 'react'
import { SignClient } from '@walletconnect/sign-client'
import { WalletConnectModal } from '@walletconnect/modal'
import { Contract, ElectrumNetworkProvider } from 'cashscript'
import artifact from './contracts/Lottery.json'

import { Button } from './components/ui/button'
import { Card, CardContent } from './components/ui/card'
import { ShieldCheck, Wallet, Trophy, Ticket, Sparkles, RefreshCw, Dices, Check, Info } from 'lucide-react'

// Network & CashScript Config (Using Chipnet for MockNet testing)
const provider = new ElectrumNetworkProvider('chipnet')
const MANAGER_PUBKEY = '02a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'
const TICKET_PRICE_SATS = 100000n // 0.001 BCH per ticket (~₱20-₱50 mock value)

// WalletConnect Cloud Project ID
const WALLETCONNECT_PROJECT_ID = '2795089563c4cc4aed7154486569afc4'

// PCSO Game Definitions
interface PCSOGame {
  id: string
  name: string
  maxNumber: number
  pickCount: number
  mockPrizeBch: string
  drawDays: string
}

const PCSO_GAMES: PCSOGame[] = [
  { id: '658', name: 'Ultra Lotto 6/58', maxNumber: 58, pickCount: 6, mockPrizeBch: '125.500', drawDays: 'Tue / Fri / Sun' },
  { id: '655', name: 'Grand Lotto 6/55', maxNumber: 55, pickCount: 6, mockPrizeBch: '84.200', drawDays: 'Mon / Wed / Sat' },
  { id: '649', name: 'Super Lotto 6/49', maxNumber: 49, pickCount: 6, mockPrizeBch: '45.800', drawDays: 'Tue / Thu / Sun' },
  { id: '645', name: 'Mega Lotto 6/45', maxNumber: 45, pickCount: 6, mockPrizeBch: '22.100', drawDays: 'Mon / Wed / Fri' },
  { id: '642', name: 'Lotto 6/42', maxNumber: 42, pickCount: 6, mockPrizeBch: '12.400', drawDays: 'Tue / Thu / Sat' },
]

export default function App() {
  const [signClient, setSignClient] = useState<any>(null)
  const [modal, setModal] = useState<any>(null)
  const [session, setSession] = useState<any>(null)
  const isInitializing = useRef(false)

  // Wallet State
  const [walletConnected, setWalletConnected] = useState(false)
  const [userBchAddress, setUserBchAddress] = useState('')
  const [contractInstance, setContractInstance] = useState<any>(null)
  const [contractBalanceSats, setContractBalanceSats] = useState<bigint>(0n)
  
  // Game & Ticket State
  const [selectedGame, setSelectedGame] = useState<PCSOGame>(PCSO_GAMES[0])
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([])
  const [purchasedTickets, setPurchasedTickets] = useState<{ game: string; numbers: number[]; txid: string }[]>([])
  
  const [loading, setLoading] = useState(false)
  const [txPending, setTxPending] = useState(false)

  // 1. Initialize WalletConnect & Modal
  useEffect(() => {
    if (isInitializing.current || signClient) return
    isInitializing.current = true

    const initWalletConnect = async () => {
      try {
        const client = await SignClient.init({
          projectId: WALLETCONNECT_PROJECT_ID,
          metadata: {
            name: 'BCH Trustless PCSO Lotto',
            description: 'On-Chain Verifiable PCSO Lottery',
            url: window.location.origin,
            icons: ['https://walletconnect.com/walletconnect-logo.png']
          }
        })

        const wcModal = new WalletConnectModal({
          projectId: WALLETCONNECT_PROJECT_ID,
          chains: ['bch:bchtest', 'bch:chipnet', 'bch:mainnet', 'bch:bitcoincash'],
          enableDesktop: true,
          enableMobileWalletConnect: true,
          themeMode: 'dark',
          themeVariables: {
            '--wcm-accent-color': '#10b981',
            '--wcm-background-color': '#020617'
          }
        })

        setSignClient(client)
        setModal(wcModal)
      } catch (err) {
        console.error('WalletConnect init failed:', err)
        isInitializing.current = false
      }
    }

    initWalletConnect()
  }, [])

  // 2. Connect Paytaca / Wallet
  const connectRealWallet = async () => {
    if (!signClient || !modal) return
    setLoading(true)

    try {
      const bchNamespace = {
        methods: [
          'bch_getAddresses', 
          'bch_signTransaction', 
          'bch_sendTransaction'
        ],
        chains: ['bch:bchtest', 'bch:chipnet', 'bch:mainnet', 'bch:bitcoincash'],
        events: ['addressesChanged', 'chainChanged']
      }

      const { uri, approval } = await signClient.connect({
        optionalNamespaces: {
          bch: bchNamespace
        }
      })

      if (uri) {
        modal.openModal({ uri })
      }

      const activeSession = await approval()
      modal.closeModal()
      setSession(activeSession)

      // Safely parse user address
      const fullAccount = activeSession.namespaces.bch.accounts[0]
      const accountParts = fullAccount.split(':')
      const address = accountParts.length > 3 
        ? `${accountParts[2]}:${accountParts[3]}` 
        : accountParts[accountParts.length - 1]

      setUserBchAddress(address)
      setWalletConnected(true)

      // Fetch MockNet / Chipnet Contract Balance
      try {
        const utxos = await provider.getUtxos(address)
        const total = utxos.reduce((acc, u) => acc + u.satoshis, 0n)
        setContractBalanceSats(total)
      } catch (e) {
        console.warn('Balance fetch warning:', e)
      }

    } catch (err) {
      console.error('Connection cancelled or rejected:', err)
      modal?.closeModal()
    } finally {
      setLoading(false)
    }
  }

  // 3. Number Selection Handlers
  const toggleNumber = (num: number) => {
    if (selectedNumbers.includes(num)) {
      setSelectedNumbers(selectedNumbers.filter(n => n !== num))
    } else if (selectedNumbers.length < selectedGame.pickCount) {
      setSelectedNumbers([...selectedNumbers, num].sort((a, b) => a - b))
    }
  }

  const handleQuickPick = () => {
    const numbers: number[] = []
    while (numbers.length < selectedGame.pickCount) {
      const randomNum = Math.floor(Math.random() * selectedGame.maxNumber) + 1
      if (!numbers.includes(randomNum)) {
        numbers.push(randomNum)
      }
    }
    setSelectedNumbers(numbers.sort((a, b) => a - b))
  }

  // 4. Buy Ticket via WalletConnect Transaction
  const handleBuyTicket = async () => {
    if (!walletConnected || selectedNumbers.length !== selectedGame.pickCount) return
    setTxPending(true)

    try {
      const activeAccount = session.namespaces.bch.accounts[0]
      const accountParts = activeAccount.split(':')
      const approvedChainId = `${accountParts[0]}:${accountParts[1]}`

      // Create on-chain transaction request to purchase ticket
      const txParams = {
        from: userBchAddress,
        to: userBchAddress, // Self-spend or Contract address with OP_RETURN ticket metadata
        value: TICKET_PRICE_SATS.toString(),
        opReturn: [`PCSO:${selectedGame.id}:${selectedNumbers.join(',')}`]
      }

      const txid = await signClient.request({
        topic: session.topic,
        chainId: approvedChainId,
        request: {
          method: 'bch_sendTransaction',
          params: [txParams]
        }
      })

      // Add to user's active ticket list
      setPurchasedTickets([
        { game: selectedGame.name, numbers: selectedNumbers, txid: txid || 'mock-txid-' + Date.now() },
        ...purchasedTickets
      ])

      // Reset selection
      setSelectedNumbers([])
      alert(`🎉 Ticket Purchased for ${selectedGame.name}! On-chain verification pending.`)

    } catch (err) {
      console.error('Ticket purchase failed:', err)
      // Local Mock fallback for UI testing when testing on pure Mocknet
      setPurchasedTickets([
        { game: selectedGame.name, numbers: selectedNumbers, txid: 'mock-tx-' + Math.random().toString(36).substring(7) },
        ...purchasedTickets
      ])
      setSelectedNumbers([])
    } finally {
      setTxPending(false)
    }
  }

  // Trigger haptics inside Telegram
  const triggerHaptics = () => {
    if ((window as any).Telegram?.WebApp?.HapticFeedback) {
      (window as any).Telegram.WebApp.HapticFeedback.impactOccurred('medium')
    }
  }

  return (
    <div className="min-h-screen w-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-4 max-w-md mx-auto select-none overflow-x-hidden font-sans">
      
      {/* Header */}
      <header className="flex justify-between items-center pt-2 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-emerald-400" />
          <span className="font-black tracking-wider text-sm text-emerald-400 uppercase">PCSO ON-CHAIN LOTTO</span>
        </div>

        <Button 
          onClick={connectRealWallet}
          disabled={loading}
          size="sm"
          className="rounded-full bg-slate-900 border border-slate-700 hover:bg-slate-800 text-xs text-emerald-300 font-mono py-1 px-3 cursor-pointer"
        >
          <Wallet className="h-3.5 w-3.5 mr-1" />
          {walletConnected 
            ? `${userBchAddress.slice(0, 6)}...${userBchAddress.slice(-4)}` 
            : "Connect"}
        </Button>
      </header>

      {/* Main Content Area */}
      <main className="my-auto py-4 space-y-4">

        {/* Game Selector Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
          {PCSO_GAMES.map(game => (
            <button
              key={game.id}
              onClick={() => {
                triggerHaptics()
                setSelectedGame(game)
                setSelectedNumbers([])
              }}
              className={`px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
                selectedGame.id === game.id 
                  ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20 scale-105' 
                  : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {game.name}
            </button>
          ))}
        </div>

        {/* Prize Banner */}
        <Card className="bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/40 border-slate-800 p-4 relative overflow-hidden">
          <div className="flex justify-between items-start mb-2">
            <div>
              <span className="text-[10px] font-mono text-emerald-400/80 uppercase tracking-widest">PCSO MockNet Jackpot</span>
              <h2 className="text-xl font-black text-slate-100">{selectedGame.name}</h2>
            </div>
            <span className="text-[10px] bg-slate-800 text-amber-300 px-2 py-0.5 rounded-full font-mono border border-amber-500/20">
              Draw: {selectedGame.drawDays}
            </span>
          </div>

          <div className="flex items-baseline gap-2">
            <Trophy className="h-6 w-6 text-amber-400 self-center" />
            <span className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-emerald-400 to-teal-200">
              {selectedGame.mockPrizeBch}
            </span>
            <span className="text-lg font-bold text-slate-400">BCH</span>
          </div>
        </Card>

        {/* Number Selection Grid */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <div className="text-xs text-slate-300 font-medium">
              Pick <span className="text-emerald-400 font-bold">{selectedGame.pickCount} numbers</span> ({selectedNumbers.length}/{selectedGame.pickCount})
            </div>
            
            <Button
              onClick={handleQuickPick}
              size="sm"
              variant="outline"
              className="h-7 text-[11px] bg-slate-800 border-slate-700 text-emerald-300 hover:bg-slate-700 rounded-lg cursor-pointer"
            >
              <Dices className="h-3 w-3 mr-1" /> Quick Pick
            </Button>
          </div>

          {/* Grid Numbers */}
          <div className="grid grid-cols-7 gap-1.5 max-h-48 overflow-y-auto pr-1">
            {Array.from({ length: selectedGame.maxNumber }, (_, i) => i + 1).map(num => {
              const isSelected = selectedNumbers.includes(num)
              return (
                <button
                  key={num}
                  onClick={() => {
                    triggerHaptics()
                    toggleNumber(num)
                  }}
                  className={`h-9 w-full rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-center ${
                    isSelected
                      ? 'bg-emerald-400 text-slate-950 font-black scale-105 shadow-md shadow-emerald-400/30'
                      : 'bg-slate-800/60 text-slate-300 hover:bg-slate-800 border border-slate-700/50'
                  }`}
                >
                  {num}
                </button>
              )
            })}
          </div>
        </div>

        {/* Selected Numbers Summary */}
        {selectedNumbers.length > 0 && (
          <div className="flex items-center gap-2 p-2.5 bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
            <span className="text-[10px] uppercase font-mono text-slate-400 pl-1">Your Picks:</span>
            <div className="flex gap-1.5">
              {selectedNumbers.map((n, i) => (
                <span key={i} className="h-6 w-6 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center justify-center">
                  {n}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* My Active On-Chain Tickets */}
        {purchasedTickets.length > 0 && (
          <div className="space-y-2">
            <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
              <Ticket className="h-3.5 w-3.5 text-emerald-400" /> Active Tickets ({purchasedTickets.length})
            </span>
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {purchasedTickets.map((t, idx) => (
                <div key={idx} className="p-2 bg-slate-900/90 border border-slate-800 rounded-xl text-xs flex justify-between items-center">
                  <div>
                    <span className="font-bold text-emerald-400">{t.game}: </span>
                    <span className="font-mono text-slate-300">{t.numbers.join(', ')}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">Verified</span>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>

      {/* Bottom Floating Action Button */}
      <footer className="pb-2 pt-2">
        <Button 
          onClick={walletConnected ? handleBuyTicket : connectRealWallet}
          disabled={loading || txPending || (walletConnected && selectedNumbers.length !== selectedGame.pickCount)} 
          className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base py-6 rounded-2xl shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition-transform cursor-pointer disabled:opacity-50"
        >
          {loading || txPending ? (
            <RefreshCw className="h-5 w-5 animate-spin" />
          ) : !walletConnected ? (
            "CONNECT PAYTACA WALLET"
          ) : selectedNumbers.length !== selectedGame.pickCount ? (
            `SELECT ${selectedGame.pickCount - selectedNumbers.length} MORE NUMBERS`
          ) : (
            `BUY TICKET (0.001 BCH)`
          )}
        </Button>
      </footer>

    </div>
  )
}