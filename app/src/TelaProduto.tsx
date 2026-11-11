import { useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ErroApi, type Api, type Produto } from './api';
import { comoPrincipal } from './regras';
import { Alerta, Botao, Cartao, cores } from './ui';

const mensagem = (e: unknown) => (e instanceof ErroApi ? e.message : 'Algo deu errado. Tente de novo.');

/**
 * Produto encontrado (ou recém-cadastrado), depois das fotos: confere nome e marca, escolhe a foto principal,
 * apaga fotos, marca como revisado. Tudo opcional: "Próximo produto" volta direto para a leitura.
 */
export function TelaProduto({ api, inicial, aviso, aoFotografar, aoProximo }: {
  api: Api;
  inicial: Produto;
  aviso?: string | null;
  aoFotografar: (p: Produto) => void;
  aoProximo: (resumo: string) => void;
}) {
  const [p, setP] = useState(inicial);
  const [nome, setNome] = useState(inicial.name ?? '');
  const [marca, setMarca] = useState(inicial.brand ?? '');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(aviso ?? null);
  const [revisado, setRevisado] = useState(false);

  const reais = p.images.filter((i) => !i.placeholder && i.id !== null);
  const mudou = nome.trim() !== (p.name ?? '') || marca.trim() !== (p.brand ?? '');

  async function fazer(qual: string, acao: () => Promise<Produto | void>, sucesso: string) {
    setOcupado(qual);
    setErro(null);
    setOk(null);
    try {
      const novo = await acao();
      if (novo) {
        setP(novo);
        // O servidor limpa espaços: o formulário passa a mostrar o que ficou gravado
        setNome(novo.name ?? '');
        setMarca(novo.brand ?? '');
      }
      setOk(sucesso);
    } catch (e) {
      setErro(mensagem(e));
    } finally {
      setOcupado(null);
    }
  }

  function opcoesDaFoto(id: number, indice: number) {
    const botoes: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (indice > 0) {
      botoes.push({
        text: 'Usar como principal',
        onPress: () => void fazer('foto', () => api.ordenar(p.id, comoPrincipal(reais.map((i) => i.id!), id)), 'Foto principal alterada.'),
      });
    }
    botoes.push({
      text: 'Apagar',
      style: 'destructive',
      onPress: () =>
        Alert.alert('Apagar esta foto?', 'Ela sai do catálogo e de quem consulta o produto.', [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Apagar', style: 'destructive', onPress: () => void fazer('foto', () => api.apagarFoto(id), 'Foto apagada.') },
        ]),
    });
    botoes.push({ text: 'Fechar', style: 'cancel' });
    Alert.alert(indice === 0 ? 'Foto principal' : `Foto ${indice + 1}`, undefined, botoes);
  }

  async function salvar() {
    if (!nome.trim()) return setErro('Informe o nome do produto.');
    await fazer('salvar', () => api.salvar(p.id, { name: nome.trim(), brand: marca.trim() }), 'Nome e marca salvos.');
  }

  async function marcarRevisado() {
    await fazer(
      'revisado',
      async () => {
        const salvo = mudou ? await api.salvar(p.id, { name: nome.trim(), brand: marca.trim() }) : null;
        const r = await api.revisado(p.id);
        setRevisado(true);
        return r ?? salvo ?? undefined;
      },
      'Cadastro marcado como revisado.',
    );
  }

  function proximo() {
    const continuar = () => aoProximo(`${p.name}: ${reais.length} foto${reais.length === 1 ? '' : 's'}${revisado ? ', revisado' : ''}.`);
    if (mudou) {
      Alert.alert('Nome ou marca não salvos', 'Você alterou o nome ou a marca e não salvou.', [
        { text: 'Voltar', style: 'cancel' },
        { text: 'Descartar', style: 'destructive', onPress: continuar },
      ]);
    } else continuar();
  }

  return (
    <ScrollView contentContainerStyle={estilos.pagina} keyboardShouldPersistTaps="handled">
      <Text style={estilos.titulo}>{p.name}</Text>
      <Text style={estilos.codigos}>{p.barcodes.map((b) => b.code).join(' · ')}{p.pending ? '  ·  pendente de atualização' : ''}</Text>
      {erro ? <Alerta>{erro}</Alerta> : null}
      {ok ? <Alerta tipo="ok">{ok}</Alerta> : null}

      <Cartao>
        <Text style={estilos.secao}>Fotos</Text>
        {reais.length ? (
          <>
            <View style={estilos.grade}>
              {reais.map((im, i) => (
                <Pressable key={im.id} accessibilityLabel={i === 0 ? 'Foto principal: opções' : `Foto ${i + 1}: opções`} onPress={() => opcoesDaFoto(im.id!, i)} disabled={!!ocupado}>
                  <Image source={{ uri: im.url }} style={[estilos.foto, i === 0 && estilos.principal]} />
                  {i === 0 ? <Text style={estilos.selo}>Principal</Text> : null}
                  {im.ai_generated ? <Text style={[estilos.selo, { top: undefined, bottom: 4 }]}>IA</Text> : null}
                </Pressable>
              ))}
            </View>
            <Text style={estilos.ajuda}>Toque numa foto para escolher a principal ou apagar.</Text>
          </>
        ) : (
          <Text style={estilos.ajuda}>Ainda sem foto real (o catálogo mostra a imagem padrão).</Text>
        )}
        <Botao titulo="📷 Tirar mais fotos" variante="secundario" disabled={!!ocupado} onPress={() => aoFotografar(p)} />
      </Cartao>

      <Cartao>
        <Text style={estilos.secao}>Conferir o cadastro</Text>
        <Text style={estilos.rotulo}>Nome</Text>
        <TextInput accessibilityLabel="Nome" style={estilos.campo} value={nome} onChangeText={setNome} autoCapitalize="sentences" maxLength={300} multiline />
        <Text style={estilos.rotulo}>Marca</Text>
        <TextInput accessibilityLabel="Marca" style={estilos.campo} value={marca} onChangeText={setMarca} autoCapitalize="words" maxLength={120} />
        <Botao titulo="Salvar nome e marca" variante="secundario" disabled={!mudou || !!ocupado} ocupado={ocupado === 'salvar'} onPress={() => void salvar()} />
        <View style={{ height: 8 }} />
        <Botao titulo={revisado ? '✓ Revisado' : 'Marcar como revisado'} variante="secundario" disabled={revisado || !!ocupado} ocupado={ocupado === 'revisado'} onPress={() => void marcarRevisado()} />
        <Text style={estilos.ajuda}>Revisado renova o prazo de atualização do cadastro e tira o produto da lista de pendentes.</Text>
      </Cartao>

      <Botao titulo="Próximo produto" disabled={!!ocupado} onPress={proximo} />
    </ScrollView>
  );
}

const estilos = StyleSheet.create({
  pagina: { padding: 16, backgroundColor: cores.fundo, flexGrow: 1 },
  titulo: { fontSize: 20, fontWeight: '700', color: cores.texto },
  codigos: { fontSize: 14, color: cores.suave, marginTop: 2, marginBottom: 12 },
  secao: { fontSize: 16, fontWeight: '700', color: cores.texto, marginBottom: 10 },
  grade: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  foto: { width: 96, height: 96, borderRadius: 8, backgroundColor: cores.borda },
  principal: { borderWidth: 3, borderColor: cores.marca },
  selo: { position: 'absolute', top: 4, left: 4, backgroundColor: cores.marca, color: '#fff', fontSize: 11, fontWeight: '700', paddingHorizontal: 5, borderRadius: 4, overflow: 'hidden' },
  ajuda: { fontSize: 13, color: cores.suave, marginVertical: 8 },
  rotulo: { fontSize: 14, color: cores.texto, fontWeight: '600', marginBottom: 4 },
  campo: { minHeight: 48, borderWidth: 1, borderColor: cores.borda, borderRadius: 8, backgroundColor: cores.branco, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: cores.texto, marginBottom: 12 },
});
